import { Octokit } from '@octokit/rest';
import type { Repository } from './types.js';

let octokit: Octokit;
const REQUEST_TIMEOUT_MS = 30_000;

export const initOctokit = (token: string, requestTimeoutMs = REQUEST_TIMEOUT_MS): void => {
  octokit = new Octokit({ auth: token });
  octokit.hook.wrap('request', (request, options) => {
    const deadline = AbortSignal.timeout(requestTimeoutMs);
    const callerSignal = options.request?.signal;
    const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
    // The inner Octokit hooks share this request's options object.
    options.request = { ...options.request, signal };
    // Octokit can swallow body-read errors while parsing a response.
    return Promise.resolve(request(options)).finally(() => signal.throwIfAborted());
  });
};

export const getOctokit = (): Octokit => {
  if (!octokit) throw new Error('Octokit not initialized. Call initOctokit first.');
  return octokit;
};

// Forks are excluded: their releases and CI belong to the upstream project.
const isMaintained = (repo: any): boolean => !repo.archived && !repo.private && !repo.fork;

export async function* listOrgRepos(name: string): AsyncGenerator<Repository> {
  const { data: user } = await getOctokit().users.getByUsername({ username: name });

  const [endpoint, params] =
    user.type === 'Organization'
      ? [getOctokit().repos.listForOrg, { org: name, per_page: 100, type: 'public' }]
      : [getOctokit().repos.listForUser, { username: name, per_page: 100, type: 'owner' }];

  for await (const response of getOctokit().paginate.iterator(endpoint as any, params as any)) {
    yield* (response.data as any[]).filter(isMaintained).map((r) => ({ fullName: r.full_name, defaultBranch: r.default_branch }));
  }
}

export const getRepoContents = async (
  owner: string, repo: string, path = '', ref?: string, rootTreeSha?: string
): Promise<string[]> => {
  const { data } = await getOctokit().repos.getContent({ owner, repo, path, ...(ref === undefined ? {} : { ref }) });
  if (path === '' && Array.isArray(data) && data.length >= 1000) {
    return getRootTreeContents(owner, repo, rootTreeSha);
  }
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

export type BranchHead = { sha: string; treeSha: string };

export type DefaultBranchHead =
  | { status: 'found'; head: BranchHead }
  | { status: 'no-branch' }
  | { status: 'no-head' };

export const getDefaultBranchHead = async (
  owner: string, repo: string, listedBranch?: string | null
): Promise<DefaultBranchHead> => {
  const branch = listedBranch || await getDefaultBranch(owner, repo);
  if (!branch) return { status: 'no-branch' };

  try {
    const { data } = await getOctokit().repos.getBranch({ owner, repo, branch });
    return { status: 'found', head: { sha: data.commit.sha, treeSha: data.commit.commit.tree.sha } };
  } catch (error) {
    if (isNotFound(error)) return { status: 'no-head' };
    throw error;
  }
};

const getDefaultBranch = async (owner: string, repo: string): Promise<string | null> => {
  try {
    const { data } = await getOctokit().repos.get({ owner, repo });
    return data.default_branch;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
};

export async function* getCommitStatus(
  owner: string,
  repo: string,
  ref: string
): AsyncGenerator<CIResult[]> {
  for (let page = 1; ; page++) {
    const { data } = await getOctokit().repos.getCombinedStatusForRef({ owner, repo, ref, per_page: 100, page });
    yield data.statuses.map((s) => ({ state: s.state, context: s.context, url: s.target_url ?? '' }));
    if (data.statuses.length < 100) return;
  }
}

export async function* getCheckRuns(
  owner: string,
  repo: string,
  ref: string
): AsyncGenerator<CIResult[]> {
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

  for await (const checkRuns of listCheckRunPages(owner, repo, ref)) {
    yield checkRuns.map((c) => ({
      state: c.status === 'completed' ? conclusionStates[c.conclusion ?? ''] ?? 'pending' : 'pending',
      context: c.name,
      url: c.html_url ?? '',
    }));
  }
}

export type CIResult = { state: string; context: string; url: string };

async function* listCheckRunPages(owner: string, repo: string, ref: string) {
  const client = getOctokit();
  const params = { owner, repo, ref, per_page: 100 };
  const { data } = await client.checks.listSuitesForRef({ ...params, per_page: 1 });
  if (data.total_count <= 1000) {
    for await (const { data: runs } of client.paginate.iterator(client.checks.listForRef, params)) yield runs;
    return;
  }

  for await (const { data: suites } of client.paginate.iterator(client.checks.listSuitesForRef, params)) {
    for (let start = 0; start < suites.length; start += CHECK_SUITE_CONCURRENCY) {
      const batch = suites.slice(start, start + CHECK_SUITE_CONCURRENCY);
      const results = await Promise.all(batch.map(({ id }) => loadCheckSuite(client, owner, repo, id)));
      for (const result of results) yield* result.pages;
      const firstFailure = results.find((result) => result.failure)?.failure;
      if (firstFailure) throw firstFailure.error;
    }
  }
}

const CHECK_SUITE_CONCURRENCY = 4;
let activeCheckSuites = 0;
const waitingCheckSuites: (() => void)[] = [];

async function loadCheckSuite(client: Octokit, owner: string, repo: string, check_suite_id: number) {
  const iterator = client.paginate.iterator(client.checks.listForSuite, { owner, repo, check_suite_id, per_page: 100 });
  const pages: Awaited<ReturnType<typeof client.checks.listForSuite>>['data']['check_runs'][] = [];
  if (activeCheckSuites < CHECK_SUITE_CONCURRENCY) activeCheckSuites++;
  else await new Promise<void>((resolve) => waitingCheckSuites.push(resolve));

  try {
    for await (const { data } of iterator) pages.push(data);
    return { pages };
  } catch (error) {
    return { pages, failure: { error } };
  } finally {
    // Hand the occupied slot directly to the next waiting suite.
    const next = waitingCheckSuites.shift();
    if (next) next();
    else activeCheckSuites--;
  }
}

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

const getRootTreeContents = async (owner: string, repo: string, tree_sha?: string): Promise<string[]> => {
  if (!tree_sha) throw new Error('Cannot establish complete root listing: missing tree SHA');
  const { data } = await getOctokit().git.getTree({ owner, repo, tree_sha });
  if (data.truncated !== false) throw new Error('Cannot establish complete root listing: truncated tree');
  return data.tree.flatMap(({ path, type }) => {
    if (!path || !type) throw new Error('Cannot establish complete root listing: incomplete tree entry');
    return type === 'tree' ? [] : [path];
  });
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
  const paths: string[] = [];
  for await (const page of getCommitFilePages(owner, repo, ref)) paths.push(...page);
  return paths;
};

export async function* getCommitFilePages(owner: string, repo: string, ref: string): AsyncGenerator<string[]> {
  const perPage = 100;
  const fileLimit = 3000;
  let fileCount = 0;
  for (let page = 1; ; page++) {
    const { data, headers } = await getOctokit().repos.getCommit({ owner, repo, ref, per_page: perPage, page });
    if (!data.files) {
      throw new Error(`Cannot establish complete commit files for ${owner}/${repo}@${ref}: missing files on page ${page}`);
    }
    fileCount += data.files.length;
    if (fileCount >= fileLimit) {
      throw new Error(`Cannot establish complete commit files for ${owner}/${repo}@${ref}: reached the ${fileLimit}-file limit`);
    }
    yield changedPaths(data.files);
    if (!headers?.link?.includes('rel="next"')) return;
  }
}

export type ComparedCommit = { sha: string; message: string };

export const compareCommits = async (
  owner: string,
  repo: string,
  base: string,
  head: BranchHead
): Promise<{ baseSha: string; headSha: string; files: string[]; getCommits: () => Promise<ComparedCommit[]> }> => {
  const { repos } = getOctokit();
  const { data: resolvedBase } = await repos.getCommit({
    owner, repo, ref: base, headers: { accept: 'application/vnd.github.sha' },
  });
  if (typeof resolvedBase !== 'string') {
    throw new Error(`Expected a commit SHA for ${owner}/${repo}@${base}`);
  }
  const endpoints = { owner, repo, base: resolvedBase, head: head.sha };
  const { base: baseSha, head: headSha } = endpoints;
  if (baseSha === headSha) return { baseSha, headSha, files: [], getCommits: async () => [] };

  const per_page = 100;
  const { data } = await repos.compareCommits({ ...endpoints, per_page, page: 1 });
  const files = (data.files?.length ?? 0) >= 300
    ? await compareTrees(owner, repo, data.merge_base_commit?.commit.tree?.sha, head.treeSha)
    : [...new Set(changedPaths(data.files ?? []))];

  const getCommits = async (): Promise<ComparedCommit[]> => {
    let pageCommits = data.commits;
    const commits: ComparedCommit[] = [];
    for (let page = 2; ; page++) {
      commits.push(...pageCommits.map(({ sha, commit }) => ({ sha, message: commit.message })));
      if (pageCommits.length < per_page) return commits;
      pageCommits = (await repos.compareCommits({ ...endpoints, per_page, page })).data.commits;
    }
  };

  return { baseSha, headSha, files, getCommits };
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
