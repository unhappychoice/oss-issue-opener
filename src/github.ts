import { Octokit } from '@octokit/rest';

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

export const listOrgRepos = async (name: string): Promise<string[]> => {
  const { data: user } = await getOctokit().users.getByUsername({ username: name });
  const repos: string[] = [];

  if (user.type === 'Organization') {
    for await (const response of getOctokit().paginate.iterator(getOctokit().repos.listForOrg, {
      org: name,
      per_page: 100,
      type: 'public',
    })) {
      repos.push(...(response.data as any[]).filter(isMaintained).map((r) => r.full_name));
    }
  } else {
    for await (const response of getOctokit().paginate.iterator(getOctokit().repos.listForUser, {
      username: name,
      per_page: 100,
      type: 'owner',
    })) {
      repos.push(...(response.data as any[]).filter(isMaintained).map((r) => r.full_name));
    }
  }
  return repos;
};

export const getRepoContents = async (owner: string, repo: string, path = ''): Promise<string[]> => {
  try {
    const { data } = await getOctokit().repos.getContent({ owner, repo, path });
    return Array.isArray(data) ? data.map((f) => f.name) : [];
  } catch {
    return [];
  }
};

export const getFileContent = async (owner: string, repo: string, path: string): Promise<string> => {
  try {
    const { data } = await getOctokit().repos.getContent({ owner, repo, path });
    if ('content' in data && data.content) {
      return Buffer.from(data.content, 'base64').toString('utf-8');
    }
    return '';
  } catch {
    return '';
  }
};

export const getDefaultBranch = async (owner: string, repo: string): Promise<string | null> => {
  try {
    const { data } = await getOctokit().repos.get({ owner, repo });
    return data.default_branch;
  } catch {
    return null;
  }
};

export const getCommitStatus = async (
  owner: string,
  repo: string,
  ref: string
): Promise<{ state: string; context: string; url: string }[]> => {
  try {
    const statuses: { state: string; context: string; url: string }[] = [];
    for (let page = 1; ; page++) {
      const { data } = await getOctokit().repos.getCombinedStatusForRef({ owner, repo, ref, per_page: 100, page });
      statuses.push(...data.statuses.map((s) => ({ state: s.state, context: s.context, url: s.target_url ?? '' })));
      if (data.statuses.length < 100) return statuses;
    }
  } catch {
    return [];
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

  try {
    const checkRuns = await getOctokit().paginate(getOctokit().checks.listForRef, { owner, repo, ref });
    return checkRuns.map((c) => ({
      state: c.status === 'completed' ? conclusionStates[c.conclusion ?? ''] ?? 'pending' : 'pending',
      context: c.name,
      url: c.html_url ?? '',
    }));
  } catch {
    return [];
  }
};

export const getLatestRelease = async (owner: string, repo: string): Promise<string | null> => {
  try {
    for (let page = 1; ; page++) {
      const { data: releases } = await getOctokit().repos.listReleases({ owner, repo, per_page: 100, page });
      const release = releases.find((release) => !release.draft);
      if (release) return release.tag_name;
      if (releases.length < 100) break;
    }

    const { data: tags } = await getOctokit().repos.listTags({ owner, repo, per_page: 1 });
    return tags[0]?.name ?? null;
  } catch {
    return null;
  }
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

export const compareCommits = async (
  owner: string,
  repo: string,
  base: string,
  head: string
): Promise<{ files: string[]; commitMessages: string[] }> => {
  const result = { files: [] as string[], commitMessages: [] as string[] };
  let needsTreeComparison = false;
  let baseTree: string | undefined;
  let headTree: string | undefined;
  for (let page = 1; ; page++) {
    const { data } = await getOctokit().repos.compareCommits({ owner, repo, base, head, per_page: 100, page });
    if (page === 1) {
      needsTreeComparison = (data.files?.length ?? 0) >= 300;
      baseTree = data.merge_base_commit?.commit.tree.sha;
      headTree = baseTree;
    }
    if (data.commits.length > 0) headTree = data.commits.at(-1)?.commit.tree?.sha;
    if (page === 1) result.files = [...new Set(data.files?.flatMap((f) =>
      f.status === 'renamed' && f.previous_filename ? [f.filename, f.previous_filename] : [f.filename]
    ) ?? [])];
    result.commitMessages.push(...data.commits.map((c) => c.commit.message));
    if (data.commits.length < 100) {
      if (needsTreeComparison) result.files = await compareTrees(owner, repo, baseTree, headTree);
      return result;
    }
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
  return data.map((i) => ({ title: i.title, number: i.number }));
};

export const createIssue = async (
  owner: string,
  repo: string,
  title: string,
  body: string,
  labels: string[]
): Promise<number> => {
  const { data } = await getOctokit().issues.create({ owner, repo, title, body, labels });
  return data.number;
};
