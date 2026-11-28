import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkPendingRelease } from '../dist/checker.js';
import { isProductionDependency } from '../dist/dependency.js';
import { getOctokit } from '../dist/github.js';
import { commitSha, initMockOctokit, mockCommitFiles, npmLock, npmLockResponse } from './helpers/github.mjs';

initMockOctokit('test-token');

for (const scenario of ['duplicate head read', 'baseline read', 'baseline parse']) {
  test(`checks a manifest-only production bump with a ${scenario} failure`, async (t) => {
    const { repos } = getOctokit();
    const baseSha = commitSha('refs/tags/v1');
    const headSha = commitSha('heads/main');
    const unavailable = Object.assign(new Error('package.json HTTP 503'), { status: 503 });
    t.mock.method(repos, 'listReleases', async () => ({ data: [{ tag_name: 'v1' }] }));
    t.mock.method(repos, 'get', async () => ({ data: { default_branch: 'main' } }));
    mockCommitFiles(t.mock, ['package.json']);
    t.mock.method(repos, 'compareCommits', async () => ({ data: {
      files: [{ filename: 'package.json' }],
      commits: [{ sha: 'bump', commit: { message: 'Bump runtime from 1.0.0 to 2.0.0' } }],
    } }));
    let headReads = 0;
    const contents = t.mock.method(repos, 'getContent', async ({ path, ref }) => {
      assert.equal(path, 'package.json');
      if (ref === headSha) {
        if (++headReads > 1) throw unavailable;
        return { data: '{"dependencies":{"runtime":"^2.0.0"}}' };
      }
      assert.equal(ref, baseSha);
      if (scenario === 'baseline read') throw unavailable;
      return { data: scenario === 'baseline parse' ? '{' : '{"dependencies":{"runtime":"^1.0.0"}}' };
    });

    const release = await checkPendingRelease('owner', 'repo', 'node');
    if (scenario === 'duplicate head read') {
      assert.deepEqual(release, {
        status: 'pending',
        changedSources: [],
        dependencyUpdates: [{ pkg: 'runtime', from: '1.0.0', to: '2.0.0' }],
        compareUrl: `https://github.com/owner/repo/compare/${baseSha}...${headSha}`,
      });
    } else {
      assert.equal(release.status, 'incomplete');
      assert.equal(release.lookupErrors.length, 1);
      if (scenario === 'baseline read') assert.equal(release.lookupErrors[0], unavailable);
      else assert.ok(release.lookupErrors[0] instanceof SyntaxError);
    }
    assert.deepEqual(contents.mock.calls.map(({ arguments: [{ ref }] }) => ref), [headSha, baseSha]);
  });
}

for (const path of ['package-lock.json', 'package.json']) {
  test(`reports only the surviving bump after partially reverting updates in ${path}`, async (t) => {
    const { repos } = getOctokit();
    const baseSha = commitSha('refs/tags/v1');
    t.mock.method(repos, 'listReleases', async () => ({ data: [{ tag_name: 'v1' }] }));
    t.mock.method(repos, 'get', async () => ({ data: { default_branch: 'main' } }));
    mockCommitFiles(t.mock, [path]);
    t.mock.method(repos, 'compareCommits', async () => ({ data: {
      files: [{ filename: path }],
      commits: [
        { sha: 'first', commit: { message: 'Bump runtime from 1.0.0 to 1.1.0' } },
        { sha: 'second', commit: { message: 'Bump runtime from 1.1.0 to 1.2.0' } },
        { sha: 'revert', commit: { message: 'Restore runtime to 1.1.0' } },
      ],
    } }));
    t.mock.method(repos, 'getContent', async ({ path: file, ref }) => file === 'package-lock.json'
      ? npmLockResponse(ref, 'v1', { runtime: '1.0.0' }, { runtime: '1.1.0' })
      : { data: JSON.stringify({ dependencies: { runtime: ref === baseSha ? '^1.0.0' : '^1.1.0' } }) });

    const release = await checkPendingRelease('owner', 'repo', 'node');
    assert.equal(release.status, 'pending');
    assert.deepEqual(release.dependencyUpdates, [{ pkg: 'runtime', from: '1.0.0', to: '1.1.0' }]);
  });
}

for (const manifestChanged of [true, false]) {
  test(`reports a lockfile lookup error when the npm manifest ${manifestChanged ? 'confirms a bump' : 'is unchanged'}`, async (t) => {
    const { repos } = getOctokit();
    const baseSha = commitSha('refs/tags/v1');
    const headSha = commitSha('heads/main');
    const paths = ['package.json', 'package-lock.json'];
    const lockError = new Error('Lockfile lookup failed');
    t.mock.method(repos, 'listReleases', async () => ({ data: [{ tag_name: 'v1' }] }));
    t.mock.method(repos, 'get', async () => ({ data: { default_branch: 'main' } }));
    mockCommitFiles(t.mock, paths);
    t.mock.method(repos, 'compareCommits', async () => ({ data: {
      files: paths.map((filename) => ({ filename })),
      commits: [{ sha: 'bump', commit: { message: 'Bump runtime from 1.0.0 to 2.0.0' } }],
    } }));
    t.mock.method(repos, 'getContent', async ({ path, ref }) => {
      if (path === 'package-lock.json') {
        if (ref === headSha) throw lockError;
        return { data: npmLock({ runtime: '1.0.0' }) };
      }
      const version = manifestChanged && ref === baseSha ? '^1.0.0' : '^2.0.0';
      return { data: JSON.stringify({ dependencies: { runtime: version } }) };
    });

    assert.deepEqual(await checkPendingRelease('owner', 'repo', 'node'), manifestChanged ? {
      status: 'pending',
      changedSources: [],
      dependencyUpdates: [{ pkg: 'runtime', from: '1.0.0', to: '2.0.0' }],
      compareUrl: `https://github.com/owner/repo/compare/${baseSha}...${headSha}`,
      lookupErrors: [lockError],
    } : { status: 'incomplete', lookupErrors: [lockError] });
  });
}

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

test('ignores a reverted production bump in package-lock.json when an unrelated yarn.lock change is also present', async (t) => {
  const { repos } = getOctokit();
  t.mock.method(repos, 'listReleases', async () => ({ data: [{ tag_name: 'v1' }] }));
  t.mock.method(repos, 'get', async () => ({ data: { default_branch: 'main' } }));
  mockCommitFiles(t.mock, ['package-lock.json', 'yarn.lock']);
  t.mock.method(repos, 'compareCommits', async () => ({ data: {
    files: [{ filename: 'package-lock.json' }, { filename: 'yarn.lock' }],
    commits: [{ sha: 'bump', commit: { message: 'Bump runtime from 1.0.0 to 2.0.0' } }],
  } }));
  t.mock.method(repos, 'getContent', async ({ path }) => {
    if (path === 'package.json') return { data: JSON.stringify({ dependencies: { runtime: '^1.0.0' } }) };
    assert.equal(path, 'package-lock.json');
    return { data: npmLock({ runtime: '1.0.0' }) };
  });

  assert.deepEqual(await checkPendingRelease('owner', 'repo', 'node'), { status: 'up-to-date' });
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
