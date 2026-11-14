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

  if (user.type === 'Organization') {
    for await (const response of getOctokit().paginate.iterator(getOctokit().repos.listForOrg, {
      org: name,
      per_page: 100,
      type: 'public',
    })) {
      repos.push(...(response.data as any[]).filter(isMaintained).map((r) => ({ fullName: r.full_name, defaultBranch: r.default_branch })));
    }
  } else {
    for await (const response of getOctokit().paginate.iterator(getOctokit().repos.listForUser, {
      username: name,
      per_page: 100,
      type: 'owner',
    })) {
      repos.push(...(response.data as any[]).filter(isMaintained).map((r) => ({ fullName: r.full_name, defaultBranch: r.default_branch })));
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

export const compareCommits = async (
  owner: string,
  repo: string,
  base: string,
  head: string
): Promise<{ files: string[]; commitMessages: string[] }> => {
  const result = { files: [] as string[], commitMessages: [] as string[] };
  for (let page = 1; ; page++) {
    const { data } = await getOctokit().repos.compareCommits({ owner, repo, base, head, per_page: 100, page });
    if (page === 1) result.files = [...new Set(data.files?.flatMap((f) =>
      f.status === 'renamed' && f.previous_filename ? [f.filename, f.previous_filename] : [f.filename]
    ) ?? [])];
    result.commitMessages.push(...data.commits.map((c) => c.commit.message));
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
