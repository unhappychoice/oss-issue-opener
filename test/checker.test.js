import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkPendingRelease } from '../dist/checker.js';
import { getOctokit } from '../dist/github.js';
import { initMockOctokit, mockCommitFiles } from './helpers/github.mjs';

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
      compareUrl: 'https://github.com/owner/repo/compare/v1.0.0...main',
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
      compareUrl: 'https://github.com/owner/repo/compare/v1.0.0...main',
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
    compareUrl: 'https://github.com/owner/repo/compare/v1.0.0...main',
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
    compareUrl: 'https://github.com/owner/repo/compare/v1.0.0...main',
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
      compareUrl: 'https://github.com/owner/repo/compare/v1.0.0...main',
    } : { status: 'up-to-date' });
  });
});

[
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
      data: path === '' ? [{ name: 'Gemfile' }] : { content: Buffer.from(gemfile).toString('base64') },
    }));

    assert.deepEqual(await checkPendingRelease('owner', 'repo', 'ruby'), production ? {
      status: 'pending',
      changedSources: [],
      dependencyUpdates: [{ pkg, from: '3.1.0', to: '3.1.1' }],
      compareUrl: 'https://github.com/owner/repo/compare/v1.0.0...main',
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
      compareUrl: 'https://github.com/owner/repo/compare/v1.0.0...main',
    });
  });
});

[
  ['npm development dependency', ['package-lock.json'], false, 'up-to-date'],
  ['npm production dependency', ['package-lock.json'], true, 'pending'],
  ['no dependency paths', ['README.md'], true, 'up-to-date'],
  ['unavailable paths', undefined, true, 'up-to-date'],
  ['multiple ecosystems in the bump', ['package-lock.json', 'Gemfile.lock'], true, 'up-to-date'],
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
    assert.ok(repos.getContent.mock.calls.every(({ arguments: [params] }) => params.path === 'package.json'));
  });
});
