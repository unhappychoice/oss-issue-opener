import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkPendingRelease } from '../dist/checker.js';
import { isProductionDependency } from '../dist/dependency.js';
import { getOctokit } from '../dist/github.js';
import { commitSha, initMockOctokit, mockCommitFiles, npmLock, npmLockResponse } from './helpers/github.mjs';

initMockOctokit('test-token');

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
      data: JSON.stringify(manifest),
    }));

    assert.equal(await isProductionDependency('owner', 'repo', pkg, 'node'), expected);
  });

  test(`Node dependency-only release decision: ${name} for ${pkg}`, async (t) => {
    const repos = getOctokit().repos;
    t.mock.method(repos, 'getContent', async ({ path, ref }) => path === 'package-lock.json'
      ? npmLockResponse(ref, 'v1', { [pkg]: '1.0.0' }, { [pkg]: '2.0.0' })
      : { data: JSON.stringify(manifest) });
    t.mock.method(repos, 'listReleases', async () => ({ data: [{ tag_name: 'v1' }] }));
    t.mock.method(repos, 'get', async () => ({ data: { default_branch: 'main' } }));
    mockCommitFiles(t.mock, ['package-lock.json']);
    t.mock.method(repos, 'compareCommits', async () => ({ data: {
      files: [{ filename: 'package-lock.json' }],
      commits: [{ sha: 'bump', commit: { message: `Bump ${pkg} from 1.0.0 to 2.0.0` } }],
    } }));

    assert.deepEqual(await checkPendingRelease('owner', 'repo', 'node'), expected ? {
      status: 'pending',
      changedSources: [],
      dependencyUpdates: [{ pkg: 'constructor', from: '1.0.0', to: '2.0.0' }],
      compareUrl: `https://github.com/owner/repo/compare/${commitSha('refs/tags/v1')}...${commitSha('heads/main')}`,
    } : { status: 'up-to-date' });
  });
});

for (const [lockfile, lockVersion, survivingProduction] of [
  ['package-lock.json', 3, false],
  ['package-lock.json', 3, true],
  ['npm-shrinkwrap.json', 1, true],
]) {
  test(`ignores a reverted production bump in ${lockfile} alongside a surviving ${survivingProduction ? 'production' : 'development'} bump`, async (t) => {
    const { repos } = getOctokit();
    const baseSha = commitSha('refs/tags/v1');
    const headSha = commitSha('heads/main');
    const surviving = survivingProduction ? '@scope/runtime' : 'tool';
    const message = 'Bump lib from 1.0.0 to 1.1.0';
    t.mock.method(repos, 'listReleases', async () => ({ data: [{ tag_name: 'v1' }] }));
    t.mock.method(repos, 'get', async () => ({ data: { default_branch: 'main' } }));
    mockCommitFiles(t.mock, [lockfile]);
    t.mock.method(repos, 'compareCommits', async () => ({ data: {
      files: [{ filename: lockfile }],
      commits: [
        { sha: 'bump-lib', commit: { message } },
        { sha: 'revert', commit: { message: 'Restore the released version of lib' } },
        { sha: 'bump-surviving', commit: { message: `Bump ${surviving} from 2.0.0 to 2.1.0` } },
      ],
    } }));
    const contents = t.mock.method(repos, 'getContent', async ({ path, ref }) => {
      if (path === 'package.json') return { data: JSON.stringify({
        dependencies: { lib: '^1.0.0', '@scope/runtime': '^2.0.0' },
        devDependencies: { tool: '^2.0.0' },
      }) };
      assert.equal(path, lockfile);
      const version = ref === baseSha ? '2.0.0' : '2.1.0';
      const versions = { lib: '1.0.0', [surviving]: version };
      if (lockVersion === 3) return { data: npmLock(versions) };
      return { data: JSON.stringify({
        lockfileVersion: 1,
        dependencies: { lib: { version: '1.0.0' }, [surviving]: { version } },
      }) };
    });

    const release = await checkPendingRelease('owner', 'repo', 'node');
    assert.deepEqual(release, survivingProduction ? {
      status: 'pending',
      changedSources: [],
      dependencyUpdates: [{ pkg: surviving, from: '2.0.0', to: '2.1.0' }],
      compareUrl: `https://github.com/owner/repo/compare/${baseSha}...${headSha}`,
    } : { status: 'up-to-date' });
    assert.deepEqual(contents.mock.calls.map(({ arguments: [{ path, ref }] }) => [path, ref]), [
      ['package.json', headSha], [lockfile, baseSha], [lockfile, headSha],
    ]);
  });
}
