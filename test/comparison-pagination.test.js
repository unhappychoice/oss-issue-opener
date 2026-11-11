import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { checkPendingRelease } from '../dist/checker.js';
import { compareCommits, getOctokit, initOctokit } from '../dist/github.js';

beforeEach(() => initOctokit('test-token'));

const commits = (count) => Array.from({ length: count }, (_, index) => ({
  commit: { message: `docs: update documentation ${index}` },
}));

const stubRelease = (t) => {
  const repos = getOctokit().repos;
  t.mock.method(repos, 'listReleases', async () => ({ data: [{ tag_name: 'v1' }] }));
  t.mock.method(repos, 'get', async () => ({ data: { default_branch: 'main' } }));
  return repos;
};

test('detects a production bump after the first 250 commits', async (t) => {
  const repos = stubRelease(t);
  const messages = [...commits(250), { commit: { message: 'Bump example from 1.0.0 to 2.0.0' } }];
  const compare = t.mock.method(repos, 'compareCommits', async ({ page, per_page }) => ({
    data: {
      ...(page === 1 ? { files: [{ filename: 'package-lock.json' }] } : {}),
      commits: messages.slice((page - 1) * per_page, page * per_page),
    },
  }));
  t.mock.method(repos, 'getContent', async () => ({
    data: { content: Buffer.from(JSON.stringify({ dependencies: { example: '^2.0.0' } })).toString('base64') },
  }));

  assert.deepEqual(await checkPendingRelease('owner', 'repo', 'node'), {
    status: 'pending',
    reasons: '**Dependency updates:**\n- example 1.0.0 -> 2.0.0',
    compareUrl: 'https://github.com/owner/repo/compare/v1...main',
  });
  assert.deepEqual(compare.mock.calls.map(({ arguments: [params] }) => params),
    [1, 2, 3].map((page) => ({ owner: 'owner', repo: 'repo', base: 'v1', head: 'main', per_page: 100, page })));
});

test('preserves source changes when later pages omit files', async (t) => {
  const repos = stubRelease(t);
  t.mock.method(repos, 'compareCommits', async ({ page }) => ({
    data: page === 1
      ? { files: [{ filename: 'src/index.ts' }], commits: commits(100) }
      : { commits: commits(1) },
  }));

  assert.deepEqual(await checkPendingRelease('owner', 'repo', 'node'), {
    status: 'pending',
    reasons: '**Source code changes:**\n- `src/index.ts`\n',
    compareUrl: 'https://github.com/owner/repo/compare/v1...main',
  });
});

test('finishes on an empty page after an exactly full page', async (t) => {
  const compare = t.mock.method(getOctokit().repos, 'compareCommits', async ({ page }) => ({
    data: { commits: page === 1 ? commits(100) : [] },
  }));

  assert.deepEqual(await compareCommits('owner', 'repo', 'v1', 'main'), {
    files: [],
    commitMessages: commits(100).map(({ commit }) => commit.message),
  });
  assert.equal(compare.mock.callCount(), 2);
});

test('propagates failures on subsequent comparison pages', async (t) => {
  const repos = stubRelease(t);
  const failure = new Error('Comparison page failed');
  t.mock.method(repos, 'compareCommits', async ({ page }) => {
    if (page > 1) throw failure;
    return { data: { files: [{ filename: 'src/index.ts' }], commits: commits(100) } };
  });

  await assert.rejects(checkPendingRelease('owner', 'repo', 'node'), (error) => error === failure);
});
