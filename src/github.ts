import { Octokit } from '@octokit/rest';
import type { Repository } from './types.js';

let octokit: Octokit;

export const initOctokit = (token: string): void => {
  octokit = new Octokit({ auth: token });
};

export const getOctokit = (): Octokit => {
  if (!octokit) throw new Error('Octokit not initialized. Call initOctokit first.');
  return octokit;
};

// Forks are excluded: their releases and CI belong to the upstream project.
const isMaintained = (repo: any): boolean => !repo.archived && !repo.private && !repo.fork;

export const listOrgRepos = async (name: string): Promise<Repository[]> => {
  const { data: user } = await getOctokit().users.getByUsername({ username: name });
  const repos: Repository[] = [];

  const [endpoint, params] =
    user.type === 'Organization'
      ? [getOctokit().repos.listForOrg, { org: name, per_page: 100, type: 'public' }]
      : [getOctokit().repos.listForUser, { username: name, per_page: 100, type: 'owner' }];

  for await (const response of getOctokit().paginate.iterator(endpoint as any, params as any)) {
    repos.push(...(response.data as any[]).filter(isMaintained).map((r) => ({ fullName: r.full_name, defaultBranch: r.default_branch })));
  }
  return repos;
};

export const getRepoContents = async (owner: string, repo: string, path = '', ref?: string): Promise<string[]> => {
  const { data } = await getOctokit().repos.getContent({ owner, repo, path, ...(ref === undefined ? {} : { ref }) });
  return Array.isArray(data) ? data.filter((entry) => entry.type !== 'dir').map((entry) => entry.name) : [];
};

export const getFileContent = async (
  owner: string, repo: string, path: string, ref?: string, optional = false
): Promise<string> => {
  try {
    const { data } = await getOctokit().repos.getContent({ owner, repo, path, ...(ref === undefined ? {} : { ref }) });
    if ('content' in data && data.content) {
      return Buffer.from(data.content, 'base64').toString('utf-8');
    }
    return '';
  } catch (error) {
    if (optional && isNotFound(error)) return '';
    throw error;
  }
};

const isNotFound = (error: unknown): boolean =>
  error instanceof Error && 'status' in error && error.status === 404;

export const getDefaultBranch = async (owner: string, repo: string): Promise<string | null> => {
  try {
    const { data } = await getOctokit().repos.get({ owner, repo });
    return data.default_branch;
  } catch {
    return null;
  }
};

export type BranchHead = { sha: string; treeSha: string };

export const getDefaultBranchHead = async (
  owner: string, repo: string, listedBranch?: string | null
): Promise<BranchHead | undefined> => {
  const branch = listedBranch || await getDefaultBranch(owner, repo);
  if (!branch) return undefined;

  const { data } = await getOctokit().repos.getBranch({ owner, repo, branch });
  return { sha: data.commit.sha, treeSha: data.commit.commit.tree.sha };
};

export const getCommitStatus = async (
  owner: string,
  repo: string,
  ref: string
): Promise<{ state: string; context: string; url: string }[]> => {
  const statuses: { state: string; context: string; url: string }[] = [];
  for (let page = 1; ; page++) {
    const { data } = await getOctokit().repos.getCombinedStatusForRef({ owner, repo, ref, per_page: 100, page });
    statuses.push(...data.statuses.map((s) => ({ state: s.state, context: s.context, url: s.target_url ?? '' })));
    if (data.statuses.length < 100) return statuses;
  }
};

export const getCheckRuns = async (
  owner: string,
  repo: string,
  ref: string
): Promise<{ state: string; context: string; url: string }[]> => {
  const conclusionStates: Record<string, string> = {
    success: 'success',
    neutral: 'success',
    skipped: 'success',
    failure: 'failure',
    timed_out: 'failure',
    action_required: 'failure',
    cancelled: 'failure',
    stale: 'failure',
    startup_failure: 'failure',
  };

  const checkRuns = await listCheckRuns(owner, repo, ref);
  return checkRuns.map((c) => ({
    state: c.status === 'completed' ? conclusionStates[c.conclusion ?? ''] ?? 'pending' : 'pending',
    context: c.name,
    url: c.html_url ?? '',
  }));
};

const listCheckRuns = async (owner: string, repo: string, ref: string) => {
  const client = getOctokit();
  const params = { owner, repo, ref, per_page: 100 };
  const { data } = await client.checks.listSuitesForRef({ ...params, per_page: 1 });
  if (data.total_count <= 1000) return client.paginate(client.checks.listForRef, params);

  const runs: Awaited<ReturnType<typeof client.checks.listForSuite>>['data']['check_runs'] = [];
  for await (const { data: suites } of client.paginate.iterator(client.checks.listSuitesForRef, params)) {
    for (const suite of suites) {
      runs.push(...await client.paginate(client.checks.listForSuite, {
        owner, repo, check_suite_id: suite.id, per_page: 100,
      }));
    }
  }
  return runs;
};

export const getLatestRelease = async (owner: string, repo: string): Promise<string | null> => {
  for (let page = 1; ; page++) {
    const { data: releases } = await getOctokit().repos.listReleases({ owner, repo, per_page: 100, page });
    const release = releases.find((release) => !release.draft);
    if (release) return release.tag_name;
    if (releases.length < 100) break;
  }

  const { data: tags } = await getOctokit().repos.listTags({ owner, repo, per_page: 1 });
  return tags[0]?.name ?? null;
};

const compareTrees = async (owner: string, repo: string, base?: string, head?: string): Promise<string[]> => {
  if (!base || !head) throw new Error('Cannot establish complete comparison: missing tree SHA');
  const trees = await Promise.all([base, head].map(async (tree_sha) => {
    const { data } = await getOctokit().git.getTree({ owner, repo, tree_sha, recursive: '1' });
    if (data.truncated !== false) throw new Error('Cannot establish complete comparison: truncated tree');
    return new Map(data.tree.filter((entry) => entry.type !== 'tree').map((entry) => {
      if (!entry.path || !entry.sha || !entry.mode || !entry.type) {
        throw new Error('Cannot establish complete comparison: incomplete tree entry');
      }
      return [entry.path, `${entry.sha}:${entry.mode}:${entry.type}`];
    }));
  }));
  return [...new Set([...trees[0].keys(), ...trees[1].keys()])]
    .filter((path) => trees[0].get(path) !== trees[1].get(path));
};

export const getCommitFiles = async (owner: string, repo: string, ref: string): Promise<string[]> => {
  const perPage = 100;
  const fileLimit = 3000;
  const paths: string[] = [];
  let fileCount = 0;
  for (let page = 1; ; page++) {
    const { data, headers } = await getOctokit().repos.getCommit({ owner, repo, ref, per_page: perPage, page });
    if (!data.files) return [];
    fileCount += data.files.length;
    if (fileCount >= fileLimit) return [];
    paths.push(...changedPaths(data.files));
    if (!headers?.link?.includes('rel="next"')) return paths;
  }
};

export type ComparedCommit = { sha: string; message: string };

export const compareCommits = async (
  owner: string,
  repo: string,
  base: string,
  head: BranchHead
): Promise<{ baseSha: string; headSha: string; files: string[]; commits: ComparedCommit[] }> => {
  const { repos } = getOctokit();
  const { data: baseCommit } = await repos.getCommit({ owner, repo, ref: base });
  const endpoints = { owner, repo, base: baseCommit.sha, head: head.sha };
  const result = { baseSha: endpoints.base, headSha: endpoints.head, files: [] as string[], commits: [] as ComparedCommit[] };
  if (result.baseSha === result.headSha) return result;

  for (let page = 1; ; page++) {
    const { data } = await repos.compareCommits({ ...endpoints, per_page: 100, page });
    if (page === 1) {
      result.files = (data.files?.length ?? 0) >= 300
        ? await compareTrees(owner, repo, data.merge_base_commit?.commit.tree?.sha, head.treeSha)
        : [...new Set(changedPaths(data.files ?? []))];
    }
    result.commits.push(...data.commits.map(({ sha, commit }) => ({ sha, message: commit.message })));
    if (data.commits.length < 100) return result;
  }
};

export const listOpenIssues = async (
  owner: string,
  repo: string,
  label: string
): Promise<{ title: string; number: number }[]> => {
  const data = await getOctokit().paginate(getOctokit().issues.listForRepo, {
    owner,
    repo,
    labels: label,
    state: 'open',
    per_page: 100,
  });
  return data.filter((i) => !i.pull_request).map((i) => ({ title: i.title, number: i.number }));
};

export const createIssue = async (
  owner: string,
  repo: string,
  title: string,
  body: string,
  labels: string[]
): Promise<number> => {
  const { data } = await getOctokit().issues.create({ owner, repo, title, body, labels });
  const appliedLabels = new Set(data.labels.map((label) => typeof label === 'string' ? label : label.name));
  const missingLabels = labels.filter((label) => !appliedLabels.has(label));
  if (missingLabels.length > 0) {
    throw new Error(`Issue ${owner}/${repo}#${data.number} was created without expected labels: ${missingLabels.join(', ')}`);
  }
  return data.number;
};

const changedPaths = (files: { filename: string; status: string; previous_filename?: string }[]): string[] =>
  files.flatMap(({ filename, status, previous_filename }) =>
    status === 'renamed' && previous_filename ? [filename, previous_filename] : [filename]
  );
