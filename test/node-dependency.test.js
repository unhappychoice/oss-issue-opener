import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkPendingRelease } from '../dist/checker.js';
import { isProductionDependency } from '../dist/dependency.js';
import { getOctokit, initOctokit } from '../dist/github.js';

initOctokit('test-token');

const cases = [
  ...['constructor', 'toString', 'hasOwnProperty'].flatMap((pkg) => [
    ['empty dependencies', { dependencies: {} }, pkg, false],
    ['absent dependencies', {}, pkg, false],
  ]),
  ['declared constructor', { dependencies: { constructor: '^2.0.0' } }, 'constructor', true],
];

cases.forEach(([name, manifest, pkg, expected]) => {
  test(`Node production dependency detection: ${name} for ${pkg}`, async (t) => {
    t.mock.method(getOctokit().repos, 'getContent', async () => ({
      data: { content: Buffer.from(JSON.stringify(manifest)).toString('base64') },
    }));

    assert.equal(await isProductionDependency('owner', 'repo', pkg, 'node'), expected);
  });

  test(`Node dependency-only release decision: ${name} for ${pkg}`, async (t) => {
    const repos = getOctokit().repos;
    t.mock.method(repos, 'getContent', async () => ({
      data: { content: Buffer.from(JSON.stringify(manifest)).toString('base64') },
    }));
    t.mock.method(repos, 'listReleases', async () => ({ data: [{ tag_name: 'v1' }] }));
    t.mock.method(repos, 'get', async () => ({ data: { default_branch: 'main' } }));
    t.mock.method(repos, 'compareCommits', async () => ({ data: {
      files: [{ filename: 'package-lock.json' }],
      commits: [{ commit: { message: `Bump ${pkg} from 1.0.0 to 2.0.0` } }],
    } }));

    assert.deepEqual(await checkPendingRelease('owner', 'repo', 'node'), expected ? {
      status: 'pending',
      reasons: '**Dependency updates:**\n- constructor 1.0.0 -> 2.0.0',
      compareUrl: 'https://github.com/owner/repo/compare/v1...main',
    } : { status: 'up-to-date' });
  });
});
