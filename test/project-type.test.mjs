import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import { checkPendingRelease } from '../dist/checker.js';
import { isProductionDependency } from '../dist/dependency.js';
import { getOctokit, initOctokit } from '../dist/github.js';
import { detectProjectType } from '../dist/project-type.js';

const owner = 'example';
const repo = 'gemfile-only';

beforeEach(() => {
  mock.restoreAll();
  initOctokit('test-token');
  mock.method(getOctokit().repos, 'getContent', async ({ path }) => ({
    data: path === ''
      ? [{ name: 'Gemfile' }]
      : { content: Buffer.from("gem 'rack'\n").toString('base64') },
  }));
});

test('classifies a repository containing only Gemfile as Ruby', async () => {
  assert.equal(await detectProjectType(owner, repo), 'ruby');
});

test('checks declared dependencies for a Gemfile-only repository', async () => {
  const type = await detectProjectType(owner, repo);
  assert.equal(await isProductionDependency(owner, repo, 'rack', type), true);
  assert.equal(await isProductionDependency(owner, repo, 'nonexistent', type), false);
});

const mockReleaseComparison = (files, commitMessages = []) => {
  mock.method(getOctokit().repos, 'listReleases', async () => ({
    data: [{ tag_name: 'v1.0.0' }],
  }));
  mock.method(getOctokit().repos, 'get', async () => ({
    data: { default_branch: 'main' },
  }));
  mock.method(getOctokit().repos, 'compareCommits', async () => ({
    data: {
      files: files.map((filename) => ({ filename })),
      commits: commitMessages.map((message) => ({ commit: { message } })),
    },
  }));
};

test('detects lib changes as pending releases for a Gemfile-only repository', async () => {
  mockReleaseComparison(['lib/example.rb']);
  const type = await detectProjectType(owner, repo);
  const release = await checkPendingRelease(owner, repo, type);
  assert.equal(release.status, 'pending');
  assert.match(release.reasons, /Source code changes:/);
  assert.match(release.reasons, /lib\/example\.rb/);
});

test('ignores undeclared dependency updates for a Gemfile-only repository', async () => {
  mockReleaseComparison(['Gemfile.lock'], ['Bump nonexistent from 1.0.0 to 2.0.0']);
  const type = await detectProjectType(owner, repo);
  assert.deepEqual(await checkPendingRelease(owner, repo, type), { status: 'up-to-date' });
});
