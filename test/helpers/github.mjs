import { createHash } from 'node:crypto';
import { mock } from 'node:test';
import { getOctokit, initOctokit } from '../../dist/github.js';

export const commitSha = (ref) => createHash('sha1').update(ref).digest('hex');

export const initMockOctokit = (token) => {
  initOctokit(token);
  mock.method(getOctokit().repos, 'getCommit', async ({ ref }) => ({
    data: { sha: commitSha(ref), commit: { tree: { sha: 'head-tree' } } },
  }));
};

export const mockCommitFiles = (tracker, paths) => {
  const { repos } = getOctokit();
  const resolveCommit = repos.getCommit.bind(repos);
  tracker.method(repos, 'getCommit', async (params) => params.page === undefined
    ? resolveCommit(params)
    : { data: { files: paths?.map((filename) => ({ filename })) } });
};

export const mockRubyRepository = (gemspec, gemfile = '') => {
  initMockOctokit('test-token');
  const repos = getOctokit().repos;
  mock.method(repos, 'getContent', async ({ path }) => ({
    data: path === '' ? [{ name: 'example.gemspec' }] : {
      content: Buffer.from(path.endsWith('.gemspec') ? gemspec : gemfile).toString('base64'),
    },
  }));
  mock.method(repos, 'listReleases', async () => ({ data: [{ tag_name: 'v1' }] }));
  mock.method(repos, 'get', async () => ({ data: { default_branch: 'main' } }));
  mockCommitFiles(mock, ['Gemfile.lock']);
  mock.method(repos, 'compareCommits', async ({ repo }) => ({ data: {
    files: [],
    commits: [{ sha: 'bump', commit: { message: repo === 'malicious'
      ? 'Bump (a+)+$ from 1 to 2' : 'Bump rake from 1 to 2' } }],
  } }));
};
