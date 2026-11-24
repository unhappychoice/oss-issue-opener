import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { checkPendingRelease } from '../dist/checker.js';
import { createDependencyChecker, isProductionDependency } from '../dist/dependency.js';
import { getOctokit } from '../dist/github.js';
import { commitSha, initMockOctokit, mockCommitFiles, npmLockResponse } from './helpers/github.mjs';

const stubRepository = (manifests, commitMessages = []) => {
  initMockOctokit('test');
  const calls = [];
  Object.assign(getOctokit().repos, {
    getContent: async ({ owner, repo, path, ref }) => {
      calls.push({ owner, repo, path });
      if (path === 'package-lock.json' && manifests[path] === undefined) {
        return npmLockResponse(ref, 'v1', { first: '0', second: '1' }, { first: '100', second: '98', dev: '99' });
      }
      const content = path === '' ? manifests[''] ?? Object.keys(manifests) : manifests[path];
      if (content === undefined) throw Object.assign(new Error('Not found'), { status: 404 });
      return { data: Array.isArray(content) ? content.map((name) => ({ name })) :
        content };
    },
    listReleases: async () => ({ data: [{ tag_name: 'v1' }] }),
    get: async () => ({ data: { default_branch: 'main' } }),
    compareCommits: async ({ page, per_page }) => ({ data: {
      files: [{ filename: 'src/main.ts' }, { filename: 'package-lock.json' }],
      commits: commitMessages.slice((page - 1) * per_page, page * per_page)
        .map((message) => ({ sha: message, commit: { message } })),
    } }),
  });
  mockCommitFiles(mock, ['package-lock.json']);
  return calls;
};

const bumps = Array.from({ length: 100 }, (_, index) => ({
  pkg: ['first', 'second', 'dev'][index % 3], from: `${index}`, to: `${index + 1}`,
}));
const messages = bumps.map(({ pkg, from, to }) => `Bump ${pkg} from ${from} to ${to}`);

test('Gradle finds direct and catalog dependencies and reads the catalog once', async () => {
  const calls = stubRepository({
    'build.gradle': `dependencies {
      implementation("org.example:direct:1.0")
      api libs.example.core
      implementation(platform(libs.example.bom))
      testImplementation(libs.example.test)
      api(libs.invalid)
      implementation(libs.missing)
    }`,
    'gradle/libs.versions.toml': `[versions]
      example = "1.0"
      [libraries]
      example-core = { module = "org.example:core", version.ref = "example" }
      example_bom = { group = "org.example", name = "bom", version.ref = "example" }
      example-test = "org.example:test:1.0"
      invalid = { group = "org.example" }
      [plugins]
      missing = { id = "org.example.missing", version = "1.0" }
    `,
  });
  const check = createDependencyChecker('owner', 'repo', 'kotlin');
  assert.deepEqual(await Promise.all(['direct', 'core', 'bom', 'test', 'invalid', 'missing'].map(
    (name) => check(`org.example:${name}`)
  )), [true, true, true, false, false, false]);
  assert.deepEqual(calls.map(({ path }) => path), ['build.gradle', 'gradle/libs.versions.toml']);
});

test('Gradle skips the catalog for direct-only scripts', async () => {
  const calls = stubRepository({
    'build.gradle': 'implementation("org.example:direct:1.0")',
    'gradle/libs.versions.toml': '[libraries]\nunused = "org.example:unused:1.0"',
  });
  const check = createDependencyChecker('owner', 'repo', 'kotlin');
  assert.equal(await check('org.example:direct'), true);
  assert.deepEqual(calls.map(({ path }) => path), ['build.gradle']);
});

[['missing', {}], ['malformed', { 'gradle/libs.versions.toml': '[libraries' }]].forEach(([state, catalog]) => {
  test(`Gradle keeps direct dependencies when the catalog is ${state}`, async () => {
    stubRepository({
      'build.gradle': 'implementation("org.example:direct:1.0"); api(libs.invalid)',
      ...catalog,
    });
    const check = createDependencyChecker('owner', 'repo', 'kotlin');
    assert.equal(await check('org.example:direct'), true);
    assert.equal(await check('org.example:invalid'), false);
  });
});

test('release checks reuse parsed Node dependencies and report updates matching the head', async () => {
  const calls = stubRepository({ 'package.json': JSON.stringify({
    dependencies: { first: '*', second: '*' }, devDependencies: { dev: '*' },
  }) }, messages);
  const result = await checkPendingRelease('owner', 'repo', 'node');
  assert.deepEqual(calls.map(({ path }) => path), ['package.json', 'package-lock.json', 'package-lock.json']);
  assert.deepEqual(result, {
    status: 'pending',
    changedSources: ['src/main.ts'],
    dependencyUpdates: [
      { pkg: 'second', from: '97', to: '98' },
      { pkg: 'first', from: '99', to: '100' },
    ],
    compareUrl: `https://github.com/owner/repo/compare/${commitSha('refs/tags/v1')}...${commitSha('heads/main')}`,
  });
  await checkPendingRelease('owner', 'repo', 'node');
  await checkPendingRelease('owner', 'other', 'node');
  assert.equal(calls.length, 9);
  assert.ok(calls.slice(6).every(({ repo }) => repo === 'other'));
});

test('Ruby reuses the root listing, gemspec and fallback Gemfile', async () => {
  const calls = stubRepository({
    '': ['example.gemspec', 'Gemfile'],
    'example.gemspec': 'spec.add_dependency "first"',
    Gemfile: 'gem "second"',
  });
  const check = createDependencyChecker('owner', 'repo', 'ruby');
  assert.deepEqual(await Promise.all([check('first'), check('first')]), [true, true]);
  assert.deepEqual(calls.map(({ path }) => path), ['', 'example.gemspec']);
  for (const { pkg } of bumps) assert.equal(await check(pkg), pkg !== 'dev');
  assert.deepEqual(calls.map(({ path }) => path), ['', 'example.gemspec', 'Gemfile']);
});

test('Ruby skips the Gemfile fallback when the root listing omits it', async () => {
  const calls = stubRepository({ '': ['example.gemspec'], 'example.gemspec': 'add_dependency "first"' });
  const check = createDependencyChecker('owner', 'repo', 'ruby');
  assert.equal(await check('first'), true);
  assert.equal(calls.length, 2);
  assert.equal(await check('missing'), false);
  assert.equal(await check('another'), false);
  assert.deepEqual(calls.map(({ path }) => path), ['', 'example.gemspec']);
  const missingCalls = stubRepository({});
  const missing = createDependencyChecker('owner', 'repo', 'ruby');
  assert.equal(await missing('first'), false);
  assert.equal(await missing('second'), false);
  assert.deepEqual(missingCalls.map(({ path }) => path), ['']);
});

test('Ruby excludes a development bump without requesting a Gemfile in a gemspec-only repository', async (t) => {
  const calls = stubRepository({
    '': ['example.gemspec'],
    'example.gemspec': 'spec.add_development_dependency "rake"',
  });
  mockCommitFiles(t.mock, ['example.gemspec']);
  t.mock.method(getOctokit().repos, 'compareCommits', async () => ({ data: {
    files: [{ filename: 'example.gemspec' }],
    commits: [{ sha: 'bump', commit: { message: 'Bump rake from 1 to 2' } }],
  } }));
  assert.deepEqual(await checkPendingRelease('owner', 'repo', 'ruby'), { status: 'up-to-date' });
  assert.deepEqual(calls.map(({ path }) => path), ['', 'example.gemspec']);
});

test('overlapping Ruby release scans share a gemspec download limit', async (t) => {
  const paths = Array.from({ length: 12 }, (_, index) => `gem-${index}.gemspec`);
  const last = paths.at(-1);
  const dependency = { pkg: 'rack', from: '3.0.0', to: '3.1.0' };
  const repos = ['first', 'second'];
  stubRepository({});
  mockCommitFiles(t.mock, [last]);
  t.mock.method(getOctokit().repos, 'compareCommits', async () => ({ data: {
    files: [{ filename: last }],
    commits: [{ sha: 'bump', commit: { message: 'Bump rack from 3.0.0 to 3.1.0' } }],
  } }));

  let inFlight = 0;
  let peak = 0;
  const downloads = [];
  t.mock.method(getOctokit().repos, 'getContent', async ({ repo, path }) => {
    if (path === '') return { data: [...paths, last].map((name) => ({ name })) };
    if (!path.endsWith('.gemspec')) throw new Error('Not found');
    downloads.push(`${repo}/${path}`);
    peak = Math.max(peak, ++inFlight);
    await setImmediate();
    inFlight--;
    return { data: path === last ? 'spec.add_runtime_dependency "rack"' : '' };
  });

  const results = await Promise.all(repos.map((repo) => checkPendingRelease('owner', repo, 'ruby')));

  assert.equal(peak, 8);
  assert.deepEqual(downloads.sort(), repos.flatMap((repo) => paths.map((path) => `${repo}/${path}`)).sort());
  assert.deepEqual(results.map(({ dependencyUpdates }) => dependencyUpdates), [[dependency], [dependency]]);
});

[['a.gemspec', 'b.gemspec', 'Gemfile'], ['Gemfile', 'b.gemspec', 'a.gemspec']].forEach((names) => {
  test(`Ruby checks every gemspec with root listing ${names.join(', ')}`, async () => {
    const calls = stubRepository({
      '': names,
      'a.gemspec': 'spec.add_dependency "json"',
      'b.gemspec': `spec.add_runtime_dependency "rack"
        spec.add_development_dependency "rake"
        # spec.add_dependency "commented"
        spec.add_dependency "rack.test"`,
      Gemfile: 'gemspec name: "a"\ngemspec name: "b"\ngem "fallback"',
    });
    const check = createDependencyChecker('owner', 'repo', 'ruby');
    for (const pkg of ['json', 'rack', 'rack.test', 'rack']) assert.equal(await check(pkg), true);
    assert.deepEqual(calls.map(({ path }) => path), ['', ...names.filter((name) => name.endsWith('.gemspec'))]);
    for (const pkg of ['rake', 'commented', 'rackXtest', 'rac']) assert.equal(await check(pkg), false);
    assert.equal(await check('fallback'), true);
    assert.equal(calls.length, 4);
  });

  test(`Ruby detects pending releases from all gemspecs with root listing ${names.join(', ')}`, async (t) => {
    stubRepository({
      '': names,
      'a.gemspec': 'spec.add_dependency "json"',
      'b.gemspec': 'spec.add_runtime_dependency "rack"',
      Gemfile: 'gemspec name: "a"\ngemspec name: "b"',
    });
    mockCommitFiles(t.mock, ['b.gemspec']);
    t.mock.method(getOctokit().repos, 'compareCommits', async () => ({ data: {
      files: [{ filename: 'b.gemspec' }, { filename: 'Gemfile.lock' }],
      commits: [{ sha: 'bump', commit: { message: 'Bump rack from 3.0.0 to 3.1.0' } }],
    } }));
    assert.deepEqual(await checkPendingRelease('owner', 'repo', 'ruby'), {
      status: 'pending',
      changedSources: [],
      dependencyUpdates: [{ pkg: 'rack', from: '3.0.0', to: '3.1.0' }],
      compareUrl: `https://github.com/owner/repo/compare/${commitSha('refs/tags/v1')}...${commitSha('heads/main')}`,
    });
  });
});

const dialects = [
  { file: 'build.gradle', declaration: (configuration, coordinate) => `${configuration} '${coordinate}'` },
  { file: 'build.gradle.kts', declaration: (configuration, coordinate) => `${configuration}("${coordinate}")` },
];

dialects.forEach(({ file, declaration }) => {
  test(`${file}: constraint-only bumps do not qualify for a release`, async (t) => {
    const content = `dependencies { constraints {
      ${declaration('implementation', 'org.example:constrained:1.1')}
      ${declaration('api', 'org.example:public:1.1')}
    }; ${declaration('implementation', 'org.example:runtime:1.0')} }`;
    const message = 'Bump org.example:constrained from 1.0 to 1.1';
    stubRepository({ [file]: content });
    mockCommitFiles(t.mock, [file]);
    t.mock.method(getOctokit().repos, 'compareCommits', async () => ({ data: {
      files: [{ filename: file }], commits: [{ sha: 'bump', commit: { message } }],
    } }));
    const check = createDependencyChecker('owner', 'repo', 'kotlin');

    assert.equal(await check('org.example:constrained'), false);
    assert.equal(await check('org.example:public'), false);
    assert.equal(await check('org.example:runtime'), true);
    assert.deepEqual(await checkPendingRelease('owner', 'repo', 'kotlin'), { status: 'up-to-date' });
  });

  test(`${file}: JVM test suite-only bumps, including the built-in test suite, do not qualify for a release`, async (t) => {
    const content = `dependencies { ${declaration('implementation', 'org.example:runtime:1.0')} }
    testing { suites {
      named("test") { dependencies { ${declaration('implementation', 'org.example:test-helper:1.1')} } }
      register("integrationTest") { dependencies { ${declaration('implementation', 'org.example:integration-helper:1.1')} } }
    } }`;
    const message = 'Bump org.example:test-helper from 1.0 to 1.1';
    stubRepository({ [file]: content });
    mockCommitFiles(t.mock, [file]);
    t.mock.method(getOctokit().repos, 'compareCommits', async () => ({ data: {
      files: [{ filename: file }], commits: [{ sha: 'bump', commit: { message } }],
    } }));
    const check = createDependencyChecker('owner', 'repo', 'kotlin');

    assert.equal(await check('org.example:test-helper'), false);
    assert.equal(await check('org.example:integration-helper'), false);
    assert.equal(await check('org.example:runtime'), true);
    assert.deepEqual(await checkPendingRelease('owner', 'repo', 'kotlin'), { status: 'up-to-date' });
  });

  ['implementation', 'api'].forEach((configuration) => {
    test(`${file}: ignores block-commented ${configuration} dependencies and test-only releases`, async (t) => {
      const content = `dependencies {
        /*
        ${declaration(configuration, 'junit:junit:4.12')}
        */
        ${declaration('testImplementation', 'junit:junit:4.13.2')}
        ${declaration('implementation', 'org.example:runtime:1.0/*literal*/')}
        ${declaration('api', 'org.example:public:1.0//literal')}
      }`;
      stubRepository({ [file]: content }, ['Bump junit:junit from 4.13.1 to 4.13.2']);
      mockCommitFiles(t.mock, [file]);
      t.mock.method(getOctokit().repos, 'compareCommits', async () => ({ data: {
        files: [{ filename: file }],
        commits: [{ sha: 'bump', commit: { message: 'Bump junit:junit from 4.13.1 to 4.13.2' } }],
      } }));
      const check = createDependencyChecker('owner', 'repo', 'kotlin');

      assert.equal(await check('junit:junit'), false);
      assert.equal(await check('org.example:runtime'), true);
      assert.equal(await check('org.example:public'), true);
      assert.deepEqual(await checkPendingRelease('owner', 'repo', 'kotlin'), { status: 'up-to-date' });
    });
  });

  ['implementation', 'api'].forEach((configuration) => {
    test(`${file}: matches the target production declaration in ${configuration}`, async (t) => {
      const content = `dependencies {
        ${declaration(configuration, 'org.example:runtime:1.0')}
        ${declaration('testImplementation', 'junit:junit:4.13.2')}
        ${declaration('testApi', 'org.example:test-api:1.0')}
        ${declaration('runtimeOnly', 'org.example:runtime-only:1.0')}
      }`;
      const getContent = t.mock.method(getOctokit().repos, 'getContent', async ({ path }) => ({
        data: path === file ? content : '',
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
    data: content,
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
  ['unknown', {}, []],
];

cases.forEach(([type, manifests, paths], index) => {
  test(`${type} reuses manifests for repeated and distinct packages (case ${index})`, async () => {
    const calls = stubRepository(manifests);
    const check = createDependencyChecker('owner', 'repo', type);
    const results = await Promise.all(bumps.map(({ pkg }) => check(pkg)));
    const hasDependencies = Object.keys(manifests).length > 0 && type !== 'node';
    assert.deepEqual(results, bumps.map(({ pkg }) => hasDependencies && pkg !== 'dev'));
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

test('Ruby indexes Gemfile statements once for concurrent repeated and distinct lookups', async (t) => {
  const declarations = [
    'gem "first", group: :test',
    'gem "first"',
    'gem "second"',
    'gem "second", group: :development',
    'gem "dev", group: :test',
  ];
  const calls = stubRepository({ Gemfile: declarations.join('\n') });
  const originalExec = RegExp.prototype.exec;
  let scopeChecks = 0;
  t.mock.method(RegExp.prototype, 'exec', function (...args) {
    if (this.source === '^(if|unless|case|begin|while|until|for)$') scopeChecks++;
    return originalExec.apply(this, args);
  });
  const check = createDependencyChecker('owner', 'repo', 'ruby');
  const packages = ['first', 'second', ...bumps.map(({ pkg }, index) => pkg === 'dev' ? pkg : `missing-${index}`)];
  const results = await Promise.all(packages.map((pkg) => check(pkg)));
  assert.deepEqual(results, packages.map((pkg) => pkg === 'first' || pkg === 'second'));
  assert.equal(scopeChecks, declarations.length);
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

[
  ['build.gradle', "group: 'org.example', name: 'runtime', version: '1.0'"],
  ['build.gradle', '(name: "runtime",\n group: "org.example", version: "1.0")'],
  ['build.gradle.kts', '(group = "org.example", name = "runtime", version = "1.0")'],
].forEach(([file, argumentsText]) => {
  ['implementation', 'api'].forEach((configuration) => {
    test(`${file}: ${configuration} named coordinates produce dependency-only releases: ${argumentsText}`, async (t) => {
      stubRepository({ [file]: `dependencies {\n${configuration} ${argumentsText}\n}` });
      mockCommitFiles(t.mock, [file]);
      t.mock.method(getOctokit().repos, 'compareCommits', async () => ({ data: {
        files: [{ filename: file }],
        commits: [{ sha: 'bump', commit: { message: 'Bump org.example:runtime from 1.0 to 1.1' } }],
      } }));
      assert.equal(await isProductionDependency('owner', 'repo', 'org.example:runtime', 'kotlin'), true);
      assert.equal(await isProductionDependency('owner', 'repo', 'org.example:run', 'kotlin'), false);
      assert.deepEqual(await checkPendingRelease('owner', 'repo', 'kotlin'), {
        status: 'pending',
        changedSources: [],
        dependencyUpdates: [{ pkg: 'org.example:runtime', from: '1.0', to: '1.1' }],
        compareUrl: `https://github.com/owner/repo/compare/${commitSha('refs/tags/v1')}...${commitSha('heads/main')}`,
      });
    });
  });
});

[
  "testImplementation group: 'org.example', name: 'runtime'",
  "testApi(group: 'org.example', name: 'runtime')",
  "// implementation group: 'org.example', name: 'runtime'",
  "/* api(group: 'org.example', name: 'runtime') */",
  "implementation group: 'org.example'\ntestImplementation name: 'runtime'",
  "api name: 'runtime'\nimplementation group: 'org.example'",
].forEach((declaration) => {
  test(`Gradle named coordinates exclude non-production declarations: ${declaration}`, async () => {
    stubRepository({ 'build.gradle': declaration });
    assert.equal(await isProductionDependency('owner', 'repo', 'org.example:runtime', 'kotlin'), false);
  });
});

[
  ['build.gradle', "implementation 'org.example:runtime:1.1'"],
  ['build.gradle.kts', 'implementation("org.example:runtime:1.1")'],
].forEach(([file, declaration]) => {
  ['dependencies { ', 'dependencies {\n testImplementation("org.example:test:1.0"); '].forEach((prefix) => {
    test(`${file}: dependency-only updates after ${JSON.stringify(prefix)} produce pending releases`, async (t) => {
      stubRepository({ [file]: `${prefix}${declaration} }` });
      mockCommitFiles(t.mock, [file]);
      t.mock.method(getOctokit().repos, 'compareCommits', async () => ({ data: {
        files: [{ filename: file }],
        commits: [{ sha: 'bump', commit: { message: 'Bump org.example:runtime from 1.0 to 1.1' } }],
      } }));
      assert.deepEqual(await checkPendingRelease('owner', 'repo', 'kotlin'), {
        status: 'pending',
        changedSources: [],
        dependencyUpdates: [{ pkg: 'org.example:runtime', from: '1.0', to: '1.1' }],
        compareUrl: `https://github.com/owner/repo/compare/${commitSha('refs/tags/v1')}...${commitSha('heads/main')}`,
      });
    });
  });
});
