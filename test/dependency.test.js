import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkPendingRelease } from '../dist/checker.js';
import { createDependencyChecker } from '../dist/dependency.js';
import { getOctokit, initOctokit } from '../dist/github.js';

const stubRepository = (manifests, commitMessages = []) => {
  initOctokit('test');
  const calls = [];
  Object.assign(getOctokit().repos, {
    getContent: async ({ owner, repo, path }) => {
      calls.push({ owner, repo, path });
      if (!(path in manifests)) throw new Error('Not found');
      const content = manifests[path];
      return { data: Array.isArray(content) ? content.map((name) => ({ name })) :
        { content: Buffer.from(content).toString('base64') } };
    },
    listReleases: async () => ({ data: [{ tag_name: 'v1' }] }),
    get: async () => ({ data: { default_branch: 'main' } }),
    compareCommits: async ({ page, per_page }) => ({ data: {
      files: [{ filename: 'src/main.ts' }],
      commits: commitMessages.slice((page - 1) * per_page, page * per_page)
        .map((message) => ({ commit: { message } })),
    } }),
  });
  return calls;
};

const bumps = Array.from({ length: 100 }, (_, index) => ({
  pkg: ['first', 'second', 'dev'][index % 3], from: `${index}`, to: `${index + 1}`,
}));
const messages = bumps.map(({ pkg, from, to }) => `Bump ${pkg} from ${from} to ${to}`);

test('release checks reuse parsed Node dependencies and preserve every production update', async () => {
  const calls = stubRepository({ 'package.json': JSON.stringify({
    dependencies: { first: '*', second: '*' }, devDependencies: { dev: '*' },
  }) }, messages);
  const result = await checkPendingRelease('owner', 'repo', 'node');
  assert.deepEqual(calls, [{ owner: 'owner', repo: 'repo', path: 'package.json' }]);
  assert.deepEqual(result, {
    status: 'pending',
    reasons: ['**Source code changes:**', '- `src/main.ts`', '', '**Dependency updates:**',
      ...bumps.filter(({ pkg }) => pkg !== 'dev').map(({ pkg, from, to }) =>
        `- ${pkg} ${from} -> ${to}`)].join('\n'),
    compareUrl: 'https://github.com/owner/repo/compare/v1...main',
  });
  await checkPendingRelease('owner', 'repo', 'node');
  await checkPendingRelease('owner', 'other', 'node');
  assert.equal(calls.length, 3);
  assert.equal(calls[2].repo, 'other');
});

test('Ruby reuses the root listing, gemspec and fallback Gemfile', async () => {
  const calls = stubRepository({
    '': ['example.gemspec', 'Gemfile'],
    'example.gemspec': 'spec.add_dependency "first"',
    Gemfile: 'gem "second"',
  });
  const check = createDependencyChecker('owner', 'repo', 'ruby');
  for (const { pkg } of bumps) assert.equal(await check(pkg), pkg !== 'dev');
  assert.deepEqual(calls.map(({ path }) => path), ['', 'example.gemspec', 'Gemfile']);
});

test('Ruby loads the fallback only when needed and caches missing files and listings', async () => {
  const calls = stubRepository({ '': ['example.gemspec'], 'example.gemspec': 'add_dependency "first"' });
  const check = createDependencyChecker('owner', 'repo', 'ruby');
  assert.equal(await check('first'), true);
  assert.equal(calls.length, 2);
  assert.equal(await check('missing'), false);
  assert.equal(await check('another'), false);
  assert.equal(calls.length, 3);
  const missingCalls = stubRepository({});
  const missing = createDependencyChecker('owner', 'repo', 'ruby');
  assert.equal(await missing('first'), false);
  assert.equal(await missing('second'), false);
  assert.deepEqual(missingCalls.map(({ path }) => path), ['', 'Gemfile']);
});

const cases = [
  ['kotlin', { 'build.gradle.kts': 'implementation("first")\napi("second")' }, ['build.gradle', 'build.gradle.kts']],
  ['kotlin', {}, ['build.gradle', 'build.gradle.kts']],
  ['rust', { 'Cargo.toml': '[dependencies]\nfirst = "1"\nsecond = "2"\n[dev-dependencies]\ndev = "3"' }, ['Cargo.toml']],
  ['rust', { 'Cargo.toml': `[dependencies.first]
version = "1"
[target.'cfg(unix)'.dependencies.second]
version = "2"
[dev-dependencies]
dev = "3"` }, ['Cargo.toml']],
  ['go', { 'go.mod': 'require (\nfirst v1\nsecond v2\n)' }, ['go.mod']],
  ['swift', { 'Package.swift': '.package(url: "first"), .package(url: "second")' }, ['Package.swift']],
  ['node', { 'package.json': '{invalid' }, ['package.json']],
  ['node', {}, ['package.json']],
  ['unknown', {}, []],
];

cases.forEach(([type, manifests, paths], index) => {
  test(`${type} reuses manifests for repeated and distinct packages (case ${index})`, async () => {
    const calls = stubRepository(manifests);
    const check = createDependencyChecker('owner', 'repo', type);
    const results = await Promise.all(bumps.map(({ pkg }) => check(pkg)));
    const hasDependencies = Object.keys(manifests).length > 0 && type !== 'node';
    assert.deepEqual(results, bumps.map(({ pkg }) => type === 'unknown' || (hasDependencies && pkg !== 'dev')));
    assert.deepEqual(calls.map(({ path }) => path), paths);
  });
});

test('release checks without dependency updates do not fetch manifests', async () => {
  const calls = stubRepository({}, ['Fix source code']);
  await checkPendingRelease('owner', 'repo', 'node');
  assert.deepEqual(calls, []);
});
