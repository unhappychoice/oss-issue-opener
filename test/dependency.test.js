import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkPendingRelease } from '../dist/checker.js';
import { createDependencyChecker, isProductionDependency } from '../dist/dependency.js';
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

const dialects = [
  { file: 'build.gradle', declaration: (configuration, coordinate) => `${configuration} '${coordinate}'` },
  { file: 'build.gradle.kts', declaration: (configuration, coordinate) => `${configuration}("${coordinate}")` },
];

dialects.forEach(({ file, declaration }) => {
  ['implementation', 'api'].forEach((configuration) => {
    test(`${file}: matches the target production declaration in ${configuration}`, async (t) => {
      const content = `dependencies {
        ${declaration(configuration, 'org.example:runtime:1.0')}
        ${declaration('testImplementation', 'junit:junit:4.13.2')}
        ${declaration('testApi', 'org.example:test-api:1.0')}
        ${declaration('runtimeOnly', 'org.example:runtime-only:1.0')}
      }`;
      const getContent = t.mock.method(getOctokit().repos, 'getContent', async ({ path }) => ({
        data: { content: Buffer.from(path === file ? content : '').toString('base64') },
      }));
      const check = createDependencyChecker('owner', 'repo', 'kotlin');

      assert.equal(await check('org.example:runtime'), true);
      assert.equal(await check('junit:junit'), false);
      assert.equal(await check('org.example:test-api'), false);
      assert.equal(await check('org.example:runtime-only'), false);
      assert.equal(await check('org.example:run'), false);
      assert.equal(await check('org.example:missing'), false);
      assert.deepEqual(getContent.mock.calls.map(({ arguments: [request] }) => request.path),
        file === 'build.gradle' ? ['build.gradle'] : ['build.gradle', 'build.gradle.kts']);
      getContent.mock.restore();
    });
  });
});

test('Kotlin declarations accept whitespace, single quotes, and unversioned coordinates', async (t) => {
  const content = `dependencies {
    implementation (
      'org.example:runtime'
    )
    api("org.example:public:1.0")
  }`;
  t.mock.method(getOctokit().repos, 'getContent', async () => ({
    data: { content: Buffer.from(content).toString('base64') },
  }));

  assert.equal(await isProductionDependency('owner', 'repo', 'org.example:runtime', 'kotlin'), true);
  assert.equal(await isProductionDependency('owner', 'repo', 'org.example:public', 'kotlin'), true);
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

test('cached Ruby checks preserve Gemfile group exclusions across packages', async () => {
  const calls = stubRepository({
    '': ['Gemfile'],
    Gemfile: 'group :development, :test do\n  gem "dev"\nend\ngem "first"\ngem "second"',
  });
  const check = createDependencyChecker('owner', 'repo', 'ruby');
  for (const { pkg } of bumps) assert.equal(await check(pkg), pkg !== 'dev');
  assert.deepEqual(calls.map(({ path }) => path), ['', 'Gemfile']);
});

test('cached Go checks preserve exact requirements and ignore other directives', async () => {
  const calls = stubRepository({
    'go.mod': 'module dev\n// require dev v1\nrequire (\nfirst v1\nsecond v2 // indirect\n)\nexclude dev v1',
  });
  const check = createDependencyChecker('owner', 'repo', 'go');
  const results = await Promise.all(bumps.map(({ pkg }) => check(pkg)));
  assert.deepEqual(results, bumps.map(({ pkg }) => pkg !== 'dev'));
  assert.equal(await check('fir'), false);
  assert.deepEqual(calls.map(({ path }) => path), ['go.mod']);
});
