import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkPendingRelease } from '../dist/checker.js';
import { getOctokit } from '../dist/github.js';
import { buildPendingReleaseIssue } from '../dist/issue.js';
import { commitSha, initMockOctokit, mockCommitFiles } from './helpers/github.mjs';

initMockOctokit('test-token');

const prefixes = ['Bump', 'chore(deps): bump', 'fix(deps): bump', 'chore: bump', 'chore(deps)!: bump'];

const stubRepository = (t, message, paths = ['package-lock.json']) => {
  const repos = getOctokit().repos;
  t.mock.method(repos, 'listReleases', async () => ({ data: [{ tag_name: 'v1.0.0' }] }));
  t.mock.method(repos, 'get', async () => ({ data: { default_branch: 'main' } }));
  mockCommitFiles(t.mock, paths);
  t.mock.method(repos, 'compareCommits', async () => ({
    data: {
      files: paths.map((filename) => ({ filename })),
      commits: [{ sha: 'commit', commit: { message } }],
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
      changedSources: [],
      dependencyUpdates: [{ pkg: '@octokit/rest', from: '21.1.1', to: '22.0.1' }],
      compareUrl: `https://github.com/owner/repo/compare/${commitSha('refs/tags/v1.0.0')}...${commitSha('heads/main')}`,
    });
  });

  test(`ignores development dependency updates with ${prefix}`, async (t) => {
    stubRepository(t, `${prefix} typescript from 7.0.1 to 7.0.2`);

    assert.deepEqual(await checkPendingRelease('owner', 'repo', 'node'), { status: 'up-to-date' });
  });
});

test('renders versions from a production dependency bump as literal text', async (t) => {
  const from = '`[old](https://example.com/old)`';
  const to = '``<https://example.com/new>``';
  stubRepository(t, `Bump @octokit/rest from ${from} to ${to}`);

  const release = await checkPendingRelease('owner', 'repo', 'node');
  assert.equal(release.status, 'pending');
  const issue = buildPendingReleaseIssue('owner/repo', release.changedSources, release.dependencyUpdates, release.compareUrl);

  assert.equal(issue.body.split('\n')[3], '- ` @octokit/rest ` `` ' + from + ' `` -> ``` ' + to + ' ```');
});

test('ignores bump text outside a dependency update subject', async (t) => {
  stubRepository(t, 'docs: explain how to Bump @octokit/rest from 21.1.1 to 22.0.1');

  assert.deepEqual(await checkPendingRelease('owner', 'repo', 'node'), { status: 'up-to-date' });
});

test('skips commit file requests for 40 Node development dependency bumps', async (t) => {
  stubRepository(t, 'Bump typescript from 7.0.1 to 7.0.2');
  const repos = getOctokit().repos;
  const packages = Array.from({ length: 40 }, (_, index) => `dev-package-${index}`);
  repos.compareCommits.mock.mockImplementation(async () => ({ data: {
    files: [{ filename: 'package-lock.json' }],
    commits: packages.map((pkg) => ({
      sha: pkg,
      commit: { message: `Bump ${pkg} from 1.0.0 to 1.1.0` },
    })),
  } }));
  repos.getContent.mock.mockImplementation(async () => ({
    data: { content: Buffer.from(JSON.stringify({
      devDependencies: Object.fromEntries(packages.map((pkg) => [pkg, '1.1.0'])),
    })).toString('base64') },
  }));

  assert.deepEqual(await checkPendingRelease('owner', 'repo', 'node'), { status: 'up-to-date' });
  assert.equal(repos.getCommit.mock.calls.filter(({ arguments: [{ page }] }) => page !== undefined).length, 0);
  assert.deepEqual(repos.getContent.mock.calls.map(({ arguments: [{ path }] }) => path), ['package.json']);
});

[
  ['no net changes', [], []],
  ['a source change', ['src/index.ts'], ['src/index.ts']],
  ['a Ruby dependency change', ['src/index.ts', 'Gemfile.lock'], ['src/index.ts']],
].forEach(([scenario, files, changedSources]) => {
  test(`ignores a reverted production dependency bump with ${scenario}`, async (t) => {
    const message = 'Bump @octokit/rest from 22.0.1 to 22.1.0';
    stubRepository(t, message);
    const repos = getOctokit().repos;
    repos.compareCommits.mock.mockImplementation(async () => ({ data: {
      files: files.map((filename) => ({ filename })),
      commits: [
        { sha: 'bump', commit: { message } },
        { sha: 'revert', commit: { message: `Revert "${message}"` } },
      ],
    } }));

    assert.deepEqual(await checkPendingRelease('owner', 'repo', ['node', 'ruby']), changedSources.length > 0 ? {
      status: 'pending',
      changedSources,
      dependencyUpdates: [],
      compareUrl: `https://github.com/owner/repo/compare/${commitSha('refs/tags/v1.0.0')}...${commitSha('heads/main')}`,
    } : { status: 'up-to-date' });
  });
});

[
  ...['dependencies', 'dev-dependencies', 'build-dependencies'].map((kind) => [
    `aliased ${kind}`,
    `[${kind}]\nserde_alias = { package = "serde", version = "1.0.219" }`,
    kind === 'dependencies',
  ]),
  [
    'inherited production aliases',
    '[dependencies]\nserde_alias = { workspace = true }\n' +
      '[workspace.dependencies]\nserde_alias = { package = "serde", version = "1.0.219" }',
    true,
  ],
].forEach(([description, manifest, isProduction]) => {
  test(`checks Rust ${description} updates without source changes`, async (t) => {
    const message = 'Bump serde from 1.0.218 to 1.0.219';
    stubRepository(t, message, ['Cargo.toml', 'Cargo.lock']);
    t.mock.method(getOctokit().repos, 'getContent', async () => ({
      data: { content: Buffer.from(manifest).toString('base64') },
    }));

    const expected = isProduction ? {
      status: 'pending',
      changedSources: [],
      dependencyUpdates: [{ pkg: 'serde', from: '1.0.218', to: '1.0.219' }],
      compareUrl: `https://github.com/owner/repo/compare/${commitSha('refs/tags/v1.0.0')}...${commitSha('heads/main')}`,
    } : { status: 'up-to-date' };
    assert.deepEqual(await checkPendingRelease('owner', 'repo', 'rust'), expected);
  });
});

[
  [['pkg/foo_test.go'], 'up-to-date'],
  [['vendor/golang.org/x/text/width/tables.go'], 'up-to-date'],
  [['pkg/foo.go'], 'pending'],
].forEach(([files, expected]) => {
  test(`checks Go source changes for ${files.join(', ')}`, async (t) => {
    const message = 'test: add edge case coverage';
    stubRepository(t, message);
    t.mock.method(getOctokit().repos, 'compareCommits', async () => ({
      data: {
        files: files.map((filename) => ({ filename })),
        commits: [{ sha: 'commit', commit: { message } }],
      },
    }));

    assert.deepEqual(await checkPendingRelease('owner', 'repo', 'go'), expected === 'pending' ? {
      status: 'pending',
      changedSources: files,
      dependencyUpdates: [],
      compareUrl: `https://github.com/owner/repo/compare/${commitSha('refs/tags/v1.0.0')}...${commitSha('heads/main')}`,
    } : { status: 'up-to-date' });
  });
});

test('passes through Markdown-significant characters in changed filenames unescaped', async (t) => {
  stubRepository(t, 'fix: handle empty input');
  const malicious = 'src/x`](https://evil.example/malware)';
  t.mock.method(getOctokit().repos, 'compareCommits', async () => ({
    data: {
      files: [{ filename: malicious }],
      commits: [{ commit: { message: 'fix: handle empty input' } }],
    },
  }));

  assert.deepEqual(await checkPendingRelease('owner', 'repo', 'node'), {
    status: 'pending',
    changedSources: [malicious],
    dependencyUpdates: [],
    compareUrl: `https://github.com/owner/repo/compare/${commitSha('refs/tags/v1.0.0')}...${commitSha('heads/main')}`,
  });
});

test('detects source changes without dependency updates', async (t) => {
  stubRepository(t, 'fix: handle empty input');
  t.mock.method(getOctokit().repos, 'compareCommits', async () => ({
    data: {
      files: [{ filename: 'src/index.ts' }],
      commits: [{ commit: { message: 'fix: handle empty input' } }],
    },
  }));

  assert.deepEqual(await checkPendingRelease('owner', 'repo', 'node'), {
    status: 'pending',
    changedSources: ['src/index.ts'],
    dependencyUpdates: [],
    compareUrl: `https://github.com/owner/repo/compare/${commitSha('refs/tags/v1.0.0')}...${commitSha('heads/main')}`,
  });
});

[
  ['src/client.ts', 'examples/client.ts', ['src/client.ts']],
  ['lib/client.ts', 'examples/client.ts', ['lib/client.ts']],
  ['examples/client.ts', 'src/client.ts', ['src/client.ts']],
  ['examples/client.ts', 'lib/client.ts', ['lib/client.ts']],
  ['examples/client.ts', 'docs/client.ts', []],
  ['src/client.ts', 'lib/client.ts', ['lib/client.ts', 'src/client.ts']],
].forEach(([previousFilename, filename, sources]) => {
  test(`checks source changes when renaming ${previousFilename} to ${filename}`, async (t) => {
    const message = 'refactor: move client example';
    stubRepository(t, message);
    t.mock.method(getOctokit().repos, 'compareCommits', async () => ({
      data: {
        files: [{ status: 'renamed', filename, previous_filename: previousFilename }],
        commits: [{ sha: 'commit', commit: { message } }],
      },
    }));

    assert.deepEqual(await checkPendingRelease('owner', 'repo', 'node'), sources.length > 0 ? {
      status: 'pending',
      changedSources: sources,
      dependencyUpdates: [],
      compareUrl: `https://github.com/owner/repo/compare/${commitSha('refs/tags/v1.0.0')}...${commitSha('heads/main')}`,
    } : { status: 'up-to-date' });
  });
});

[
  ["gem 'rack'", true],
  ["gem 'rack', group: :test", false],
  ["gem 'rack', group: :'test'", false],
  ['gem "rack", group: :"development"', false],
  ["gem 'rack', group: :'production'", true],
  ["gem 'rack', groups: [:'test', :production]", true],
  ["group :test do\n  def test_helper\n    true\n  end\n  gem 'rspec'\nend\ngem 'rack'", false, 'rspec'],
  ["group :development do\n  def test_helper\n    def nested_helper\n      true\n    end\n  end\n  gem 'rspec'\nend\ngem 'rack'", false, 'rspec'],
  ["group :test do\n  def test_helper\n    true\n  end\n  gem 'rspec'\nend\ngem 'rack'", true],
  ["gem \\\n  'rack', '~> 3.0'", true],
  ["gem 'rubocop', \\\n  group: :development", false, 'rubocop'],
  ["message = <<~TEXT\ngem 'rack'\nTEXT\ngroup :development do\n  gem 'rack'\nend", false],
  ["group :production, :test do\n  gem 'rack'\nend", true],
  ["group :development, :production do\n  gem 'rack'\nend", true],
  ["gem 'rack', groups: [:production, :test]", true],
  ["gem 'rack', groups: [:development, :production]", true],
  ["group :development, :test do\n  gem 'rack'\nend", false],
  ["group(:production) { gem 'rack' }", true],
  ["source('https://rubygems.org') { gem 'rack' }", true],
  ["group(:development, :production) { gem 'rack' }", true],
  ["group(:development, :test) { gem 'rack' }", false],
  ["group(:test) { source('https://rubygems.org') { gem 'rack' } }", false],
  ["gem 'rack', groups: [:development, :test]", false],
].forEach(([gemfile, production, pkg = 'rack']) => {
  test(`checks Ruby dependency-only updates for ${gemfile}`, async (t) => {
    const message = `Bump ${pkg} from 3.1.0 to 3.1.1`;
    stubRepository(t, message, ['Gemfile.lock']);
    t.mock.method(getOctokit().repos, 'getContent', async ({ path }) => ({
      data: path === '' ? [{ name: 'Gemfile', type: 'file' }] : { content: Buffer.from(gemfile).toString('base64') },
    }));

    assert.deepEqual(await checkPendingRelease('owner', 'repo', 'ruby'), production ? {
      status: 'pending',
      changedSources: [],
      dependencyUpdates: [{ pkg, from: '3.1.0', to: '3.1.1' }],
      compareUrl: `https://github.com/owner/repo/compare/${commitSha('refs/tags/v1.0.0')}...${commitSha('heads/main')}`,
    } : { status: 'up-to-date' });
  });
});

[
  ['build.gradle.kts', 'implementation(platform("org.example:bom:1.1"))'],
  ['build.gradle.kts', 'api(enforcedPlatform("org.example:bom:1.1"))'],
  ['build.gradle', "implementation platform('org.example:bom:1.1')"],
  ['build.gradle', "api enforcedPlatform('org.example:bom:1.1')"],
  ['build.gradle.kts', 'testImplementation(platform("org.example:bom:1.1"))'],
  ['build.gradle', "testImplementation enforcedPlatform('org.example:bom:1.1')"],
].forEach(([manifest, declaration]) => {
  test(`checks Gradle BOM-only updates for ${manifest}: ${declaration}`, async (t) => {
    const message = 'Bump org.example:bom from 1.0 to 1.1';
    stubRepository(t, message, [manifest]);
    t.mock.method(getOctokit().repos, 'getContent', async ({ path }) => ({
      data: { content: Buffer.from(path === manifest ? `dependencies { ${declaration} }` : '').toString('base64') },
    }));

    assert.deepEqual(await checkPendingRelease('owner', 'repo', 'kotlin'), declaration.startsWith('test') ? {
      status: 'up-to-date',
    } : {
      status: 'pending',
      changedSources: [],
      dependencyUpdates: [{ pkg: 'org.example:bom', from: '1.0', to: '1.1' }],
      compareUrl: `https://github.com/owner/repo/compare/${commitSha('refs/tags/v1.0.0')}...${commitSha('heads/main')}`,
    });
  });
});

[
  ['build.gradle.kts', 'implementation(libs.guava.core)', true],
  ['build.gradle.kts', 'implementation(libs.guava.core.get())', true],
  ['build.gradle', 'implementation libs.guava.core', true],
  ['build.gradle', 'testImplementation(libs.guava.core)', false],
  ['build.gradle.kts', 'implementation(libs.bundles.runtime.core)', true],
  ['build.gradle', 'api libs.bundles.runtime.core', true],
  ['build.gradle.kts', 'testImplementation(libs.bundles.runtime.core)', false],
  ['build.gradle.kts', 'implementation(libs.bundles.missing)', false],
  ['build.gradle.kts', 'api(libs.bundles.invalid)', false],
].forEach(([manifest, declaration, production]) => {
  test(`checks catalog-only Guava updates with ${declaration}`, async (t) => {
    const catalog = 'gradle/libs.versions.toml';
    const pkg = 'com.google.guava:guava';
    const from = '33.4.0-jre';
    const to = '33.5.0-jre';
    stubRepository(t, `Bump ${pkg} from ${from} to ${to}`, [catalog]);
    const files = {
      [manifest]: `dependencies { ${declaration} }`,
      [catalog]: `[libraries]
        guava-core = "${pkg}:${to}"
        other_lib = "org.example:other:1.0"
        [bundles]
        runtime_core = ["other_lib", "guava-core"]
        invalid = "guava-core"
      `,
    };
    t.mock.method(getOctokit().repos, 'getContent', async ({ path }) => ({
      data: { content: Buffer.from(files[path] ?? '').toString('base64') },
    }));

    assert.deepEqual(await checkPendingRelease('owner', 'repo', 'kotlin'), production ? {
      status: 'pending',
      changedSources: [],
      dependencyUpdates: [{ pkg, from, to }],
      compareUrl: `https://github.com/owner/repo/compare/${commitSha('refs/tags/v1.0.0')}...${commitSha('heads/main')}`,
    } : { status: 'up-to-date' });
  });
});

[
  ['npm development dependency', ['package-lock.json'], false, 'up-to-date'],
  ['npm production dependency', ['package-lock.json'], true, 'pending'],
  ['no dependency paths', ['README.md'], true, 'up-to-date'],
  ['an empty file list', [], true, 'up-to-date'],
  ['multiple production ecosystems in the bump', ['package-lock.json', 'Gemfile.lock'], true, 'up-to-date'],
  ['multiple ecosystems in the bump with only one production match', ['package-lock.json', 'Cargo.lock'], true, 'up-to-date'],
  ['an undetected ecosystem', ['Cargo.lock'], true, 'up-to-date'],
].forEach(([scenario, paths, production, status]) => {
  test(`attributes a bump using its own paths with ${scenario}`, async (t) => {
    const message = 'Bump dotenv from 16.4.5 to 16.4.7';
    stubRepository(t, message);
    const repos = getOctokit().repos;
    repos.compareCommits.mock.mockImplementation(async () => ({ data: {
      files: ['package-lock.json', 'Gemfile.lock'].map((filename) => ({ filename })),
      commits: [
        { sha: 'ruby-change', commit: { message: 'chore: update Ruby dependencies' } },
        { sha: 'bump', commit: { message } },
      ],
    } }));
    mockCommitFiles(t.mock, paths);
    repos.getContent.mock.mockImplementation(async ({ path }) => {
      if (path === '') return { data: [{ name: 'Gemfile', type: 'file' }] };
      const content = path === 'Gemfile' ? "gem 'dotenv'" : JSON.stringify({
        [production ? 'dependencies' : 'devDependencies']: { dotenv: '16.4.7' },
      });
      return { data: { content: Buffer.from(content).toString('base64') } };
    });

    const result = await checkPendingRelease('owner', 'repo', ['node', 'ruby']);
    assert.equal(result.status, status);
    if (status === 'pending') {
      assert.deepEqual(result.dependencyUpdates, [{ pkg: 'dotenv', from: '16.4.5', to: '16.4.7' }]);
    }
    assert.deepEqual(repos.getCommit.mock.calls.flatMap(({ arguments: [{ ref, page }] }) =>
      page === undefined ? [] : [ref]), ['bump']);
    assert.deepEqual(repos.getContent.mock.calls
      .filter(({ arguments: [{ path }] }) => path)
      .map(({ arguments: [{ path }] }) => path).sort(), ['Gemfile', 'package.json']);
  });
});

[
  ['both ecosystems on page one', [1], 1, true, [1], 'up-to-date'],
  ['a second ecosystem on page two', [1], 2, true, [1, 2], 'up-to-date'],
  ['an ineligible ecosystem on page one', [2], 1, false, [1], 'up-to-date'],
  ['only the eligible ecosystem', [2, 20], undefined, true, Array.from({ length: 20 }, (_, i) => i + 1), 'pending'],
].forEach(([scenario, nodePages, rubyPage, rubyProduction, expectedPages, status]) => {
  test(`paginates a production bump with ${scenario}`, async (t) => {
    stubRepository(t, 'Bump dotenv from 16.4.5 to 16.4.7', ['package-lock.json', 'Gemfile.lock']);
    const { repos } = getOctokit();
    repos.getContent.mock.mockImplementation(async ({ path }) => {
      if (path === '') return { data: [{ name: 'Gemfile', type: 'file' }] };
      const content = path === 'Gemfile'
        ? (rubyProduction ? "gem 'dotenv'" : "gem 'rack'")
        : JSON.stringify({ dependencies: { dotenv: '16.4.7' } });
      return { data: { content: Buffer.from(content).toString('base64') } };
    });
    const pages = [];
    t.mock.method(repos, 'getCommit', async ({ ref, page }) => {
      if (page === undefined) return { data: ref };
      pages.push(page);
      const files = nodePages.includes(page) ? [{ filename: 'package-lock.json' }] : [];
      if (page === rubyPage) {
        files.push({ filename: 'docs/old-gemfile.lock', status: 'renamed', previous_filename: 'Gemfile.lock' });
      }
      files.push({ filename: `docs/page-${page}.md` });
      return { data: { files }, headers: { link: page < 20 ? '<next>; rel="next"' : '' } };
    });

    const result = await checkPendingRelease('owner', 'repo', ['node', 'ruby']);
    assert.equal(result.status, status);
    assert.deepEqual(pages, expectedPages);
  });
});

[
  ['skips', 'commit', 'up-to-date'],
  ['reports', 'rust-change', 'pending'],
].forEach(([action, renameCommit, status]) => {
  test(`${action} a Node production bump when the Rust lockfile rename is in ${renameCommit}`, async (t) => {
    const message = 'Bump @octokit/rest from 21 to 22';
    stubRepository(t, message);
    const { repos } = getOctokit();
    const nodeFile = { filename: 'package-lock.json', status: 'modified' };
    const rustRename = { filename: 'docs/old-cargo.lock', status: 'renamed', previous_filename: 'Cargo.lock' };
    repos.compareCommits.mock.mockImplementation(async () => ({ data: {
      files: [nodeFile, rustRename],
      commits: [
        { sha: 'rust-change', commit: { message: 'chore: move Rust lockfile' } },
        { sha: 'commit', commit: { message } },
      ],
    } }));
    const resolveCommit = repos.getCommit.bind(repos);
    t.mock.method(repos, 'getCommit', async (params) => params.page === undefined
      ? resolveCommit(params)
      : { data: { files: params.ref === renameCommit ? [nodeFile, rustRename] : [nodeFile] } });

    const result = await checkPendingRelease('owner', 'repo', ['node', 'rust']);
    assert.equal(result.status, status);
    if (status === 'pending') {
      assert.deepEqual(result.dependencyUpdates, [{ pkg: '@octokit/rest', from: '21', to: '22' }]);
    }
  });
});

test('shares the bump lookup limit across scans and holds slots across pages', async (t) => {
  stubRepository(t, 'Bump @octokit/rest from 21 to 22');
  const repos = getOctokit().repos;
  const versions = Array.from({ length: 10 }, (_, index) => String(index));
  repos.compareCommits.mock.mockImplementation(async () => ({ data: {
    files: [{ filename: 'package-lock.json' }],
    commits: versions.map((version) => ({
      sha: version,
      commit: { message: `Bump @octokit/rest from ${version} to 22` },
    })),
  } }));

  const started = [];
  const first = Promise.withResolvers();
  let nextPageStarted = false;
  const finishFirst = Promise.withResolvers();
  const rest = Promise.withResolvers();
  t.mock.method(repos, 'getCommit', async ({ repo, ref, page }) => {
    if (page === undefined) return { data: ref };
    const lookup = `${repo}/${ref}`;
    if (page === 1) started.push(lookup);
    if (lookup === 'first/0' && page === 1) {
      await first.promise;
      return { data: { files: [] }, headers: { link: '<https://api.github.com/?page=2>; rel="next"' } };
    }
    if (lookup === 'first/0') {
      nextPageStarted = true;
      await finishFirst.promise;
    } else {
      await rest.promise;
    }
    return { data: { files: [{ filename: 'package-lock.json' }] } };
  });

  const scans = Promise.all(['first', 'second'].map((repo) => checkPendingRelease('owner', repo, 'node')));
  try {
    await new Promise(setImmediate);
    assert.equal(started.length, 16);
    assert.equal(new Set(started.map((lookup) => lookup.split('/')[0])).size, 2);
    first.resolve();
    await new Promise(setImmediate);
    assert.equal(nextPageStarted, true);
    assert.equal(started.length, 16);
    rest.resolve();
    await new Promise(setImmediate);
    assert.equal(started.length, 20);
  } finally {
    first.resolve();
    finishFirst.resolve();
    rest.resolve();
    const results = await scans;
    for (const result of results) {
      assert.equal(result.status, 'pending');
      assert.deepEqual(result.dependencyUpdates, versions.map((from) => ({ pkg: '@octokit/rest', from, to: '22' })));
    }
  }
});

test('reports an incomplete release check when its only bump lookup fails', async (t) => {
  stubRepository(t, 'Bump @octokit/rest from 21 to 22');
  const failure = new Error('Commit files unavailable');
  t.mock.method(getOctokit().repos, 'getCommit', async ({ ref, page }) => {
    if (page !== undefined) throw failure;
    return { data: ref };
  });

  assert.deepEqual(await checkPendingRelease('owner', 'repo', 'node'), {
    status: 'incomplete',
    lookupErrors: [failure],
  });
});

test('reports an incomplete release check at the commit file cap', async (t) => {
  stubRepository(t, 'Bump @octokit/rest from 21 to 22');
  const getCommit = t.mock.method(getOctokit().repos, 'getCommit', async ({ ref, page }) => {
    if (page === undefined) return { data: ref };
    const files = Array.from({ length: 100 }, (_, index) => ({
      filename: page === 1 && index === 0 ? 'package-lock.json' : `docs/${page}-${index}.md`,
    }));
    return { data: { files }, headers: { link: page < 30 ? '<next>; rel="next"' : '' } };
  });

  assert.deepEqual(await checkPendingRelease('owner', 'repo', 'node'), {
    status: 'incomplete',
    lookupErrors: [new Error('Cannot establish complete commit files for owner/repo@commit: reached the 3000-file limit')],
  });
  assert.equal(getCommit.mock.callCount(), 31);
});
