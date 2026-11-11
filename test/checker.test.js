import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkPendingRelease } from '../dist/checker.js';
import { getOctokit, initOctokit } from '../dist/github.js';

initOctokit('test-token');

const prefixes = ['Bump', 'chore(deps): bump', 'fix(deps): bump', 'chore: bump', 'chore(deps)!: bump'];

const stubRepository = (t, message) => {
  const repos = getOctokit().repos;
  t.mock.method(repos, 'listReleases', async () => ({ data: [{ tag_name: 'v1.0.0' }] }));
  t.mock.method(repos, 'get', async () => ({ data: { default_branch: 'main' } }));
  t.mock.method(repos, 'compareCommits', async () => ({
    data: {
      files: [{ filename: 'package-lock.json' }],
      commits: [{ commit: { message } }],
    },
  }));
  t.mock.method(repos, 'getContent', async () => ({
    data: { content: Buffer.from(JSON.stringify({
      dependencies: { '@octokit/rest': '^22.0.1' },
      devDependencies: { typescript: '^7.0.2' },
    })).toString('base64') },
  }));
};

prefixes.forEach((prefix) => {
  test(`detects production dependency updates with ${prefix}`, async (t) => {
    stubRepository(t, `${prefix} @octokit/rest from 21.1.1 to 22.0.1\n\nCommit body`);

    assert.deepEqual(await checkPendingRelease('owner', 'repo', 'node'), {
      status: 'pending',
      reasons: '**Dependency updates:**\n- @octokit/rest 21.1.1 -> 22.0.1',
      compareUrl: 'https://github.com/owner/repo/compare/v1.0.0...main',
    });
  });

  test(`ignores development dependency updates with ${prefix}`, async (t) => {
    stubRepository(t, `${prefix} typescript from 7.0.1 to 7.0.2`);

    assert.deepEqual(await checkPendingRelease('owner', 'repo', 'node'), { status: 'up-to-date' });
  });
});

test('ignores bump text outside a dependency update subject', async (t) => {
  stubRepository(t, 'docs: explain how to Bump @octokit/rest from 21.1.1 to 22.0.1');

  assert.deepEqual(await checkPendingRelease('owner', 'repo', 'node'), { status: 'up-to-date' });
});
