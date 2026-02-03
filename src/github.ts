import { Octokit } from '@octokit/rest';

let octokit: Octokit;

export const initOctokit = (token: string): void => {
  octokit = new Octokit({ auth: token });
};

export const getOctokit = (): Octokit => {
  if (!octokit) throw new Error('Octokit not initialized. Call initOctokit first.');
  return octokit;
};

export const listOrgRepos = async (name: string): Promise<string[]> => {
  const { data: user } = await getOctokit().users.getByUsername({ username: name });
  const repos: string[] = [];

  if (user.type === 'Organization') {
    for await (const response of getOctokit().paginate.iterator(getOctokit().repos.listForOrg, {
      org: name,
      per_page: 100,
      type: 'public',
    })) {
      repos.push(...(response.data as any[]).filter((r) => !r.archived).map((r) => r.full_name));
    }
  } else {
    for await (const response of getOctokit().paginate.iterator(getOctokit().repos.listForUser, {
      username: name,
      per_page: 100,
      type: 'owner',
    })) {
      repos.push(...(response.data as any[]).filter((r) => !r.archived && !r.private).map((r) => r.full_name));
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
): Promise<{ state: string; context: string }[]> => {
  try {
    const { data } = await getOctokit().repos.getCombinedStatusForRef({ owner, repo, ref });
    return data.statuses.map((s) => ({ state: s.state, context: s.context }));
  } catch {
    return [];
  }
};

export const getCheckRuns = async (
  owner: string,
  repo: string,
  ref: string
): Promise<{ state: string; context: string }[]> => {
  const conclusionToState = (conclusion: string | null): string =>
    conclusion === 'success' ? 'success' : conclusion === 'failure' || conclusion === 'timed_out' ? 'failure' : 'pending';

  try {
    const { data } = await getOctokit().checks.listForRef({ owner, repo, ref });
    return data.check_runs.map((c) => ({
      state: c.status === 'completed' ? conclusionToState(c.conclusion) : 'pending',
      context: c.name,
    }));
  } catch {
    return [];
  }
};

export const getLatestRelease = async (owner: string, repo: string): Promise<string | null> => {
  try {
    const { data } = await getOctokit().repos.getLatestRelease({ owner, repo });
    return data.tag_name;
  } catch {
    try {
      const { data } = await getOctokit().repos.listTags({ owner, repo, per_page: 1 });
      return data[0]?.name ?? null;
    } catch {
      return null;
    }
  }
};

export const compareCommits = async (
  owner: string,
  repo: string,
  base: string,
  head: string
): Promise<{ files: string[]; commitMessages: string[] }> => {
  try {
    const { data } = await getOctokit().repos.compareCommits({ owner, repo, base, head });
    return {
      files: data.files?.map((f) => f.filename) ?? [],
      commitMessages: data.commits.map((c) => c.commit.message),
    };
  } catch {
    return { files: [], commitMessages: [] };
  }
};

export const listOpenIssues = async (
  owner: string,
  repo: string,
  label: string
): Promise<{ title: string; number: number }[]> => {
  try {
    const { data } = await getOctokit().issues.listForRepo({
      owner,
      repo,
      labels: label,
      state: 'open',
    });
    return data.map((i) => ({ title: i.title, number: i.number }));
  } catch {
    return [];
  }
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
