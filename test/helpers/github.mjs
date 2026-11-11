import { mock } from 'node:test';
import { getOctokit, initOctokit } from '../../dist/github.js';

export const mockRubyRepository = (gemspec, gemfile = '') => {
  initOctokit('test-token');
  const repos = getOctokit().repos;
  mock.method(repos, 'getContent', async ({ path }) => ({
    data: path === '' ? [{ name: 'example.gemspec' }] : {
      content: Buffer.from(path.endsWith('.gemspec') ? gemspec : gemfile).toString('base64'),
    },
  }));
  mock.method(repos, 'listReleases', async () => ({ data: [{ tag_name: 'v1' }] }));
  mock.method(repos, 'get', async () => ({ data: { default_branch: 'main' } }));
  mock.method(repos, 'compareCommits', async ({ repo }) => ({ data: {
    files: [],
    commits: [{ commit: { message: repo === 'malicious'
      ? 'Bump (a+)+$ from 1 to 2' : 'Bump rake from 1 to 2' } }],
  } }));
};
