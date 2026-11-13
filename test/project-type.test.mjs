import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import { checkPendingRelease } from '../dist/checker.js';
import { isProductionDependency } from '../dist/dependency.js';
import { getOctokit, initOctokit } from '../dist/github.js';
import { detectProjectTypes } from '../dist/project-type.js';

const owner = 'example';
const repo = 'gemfile-only';

beforeEach(() => {
  mock.restoreAll();
  initOctokit('test-token');
  mock.method(getOctokit().repos, 'getContent', async ({ path }) => ({
    data: path === ''
      ? [{ name: 'Gemfile' }]
      : { content: Buffer.from("gem 'rack'\n").toString('base64') },
  }));
});

test('classifies a repository containing only Gemfile as Ruby', async () => {
  assert.deepEqual(await detectProjectTypes(owner, repo), ['ruby']);
});

test('checks declared dependencies for a Gemfile-only repository', async () => {
  const type = await detectProjectTypes(owner, repo);
  assert.equal(await isProductionDependency(owner, repo, 'rack', type), true);
  assert.equal(await isProductionDependency(owner, repo, 'nonexistent', type), false);
});

const mockReleaseComparison = (files, commitMessages = []) => {
  mock.method(getOctokit().repos, 'listReleases', async () => ({
    data: [{ tag_name: 'v1.0.0' }],
  }));
  mock.method(getOctokit().repos, 'get', async () => ({
    data: { default_branch: 'main' },
  }));
  mock.method(getOctokit().repos, 'compareCommits', async () => ({
    data: {
      files: files.map((filename) => ({ filename })),
      commits: commitMessages.map((message) => ({ commit: { message } })),
    },
  }));
};

test('detects lib changes as pending releases for a Gemfile-only repository', async () => {
  mockReleaseComparison(['lib/example.rb']);
  const type = await detectProjectTypes(owner, repo);
  const release = await checkPendingRelease(owner, repo, type);
  assert.equal(release.status, 'pending');
  assert.match(release.reasons, /Source code changes:/);
  assert.match(release.reasons, /lib\/example\.rb/);
});

test('ignores undeclared dependency updates for a Gemfile-only repository', async () => {
  mockReleaseComparison(['Gemfile.lock'], ['Bump nonexistent from 1.0.0 to 2.0.0']);
  const type = await detectProjectTypes(owner, repo);
  assert.deepEqual(await checkPendingRelease(owner, repo, type), { status: 'up-to-date' });
});

const mockManifests = (manifests) => {
  mock.method(getOctokit().repos, 'getContent', async ({ path }) => ({
    data: path === ''
      ? Object.keys(manifests).map((name) => ({ name }))
      : { content: Buffer.from(manifests[path] ?? '').toString('base64') },
  }));
};

[
  [['package.json'], ['node']],
  [['Cargo.toml'], ['rust']],
  [['example.gemspec', 'Gemfile'], ['ruby']],
  [['build.gradle.kts'], ['kotlin']],
  [['go.mod'], ['go']],
  [['Package.swift'], ['swift']],
  [['README.md'], ['unknown']],
  [['Gemfile', 'package.json', 'example.gemspec'], ['node', 'ruby']],
  [['Cargo.toml', 'package.json', 'go.mod'], ['rust', 'node', 'go']],
].forEach(([files, expected]) => {
  test(`detects all unique ecosystems for ${files.join(', ')}`, async () => {
    mockManifests(Object.fromEntries(files.map((file) => [file, ''])));
    assert.deepEqual(await detectProjectTypes(owner, repo), expected);
  });
});

['Gemfile', 'example.gemspec'].forEach((rubyManifest) => {
  const rubyContent = rubyManifest === 'Gemfile'
    ? "gem 'rack', '3.1.0'"
    : "spec.add_runtime_dependency 'rack', '3.1.0'";

  [
    ['rack', 'pending'],
    ['prettier', 'up-to-date'],
    ['express', 'pending'],
    ['nonexistent', 'up-to-date'],
  ].forEach(([pkg, expected]) => {
    test(`checks ${pkg} when ${rubyManifest} coexists with Node tooling`, async () => {
      mockManifests({
        [rubyManifest]: rubyContent,
        'package.json': JSON.stringify({
          dependencies: { express: '3.1.0' }, devDependencies: { prettier: '3' },
        }),
      });
      mockReleaseComparison([rubyManifest, 'Gemfile.lock', 'package.json'], [
        `Bump ${pkg} from 3.0.0 to 3.1.0`,
      ]);
      const types = await detectProjectTypes(owner, repo);
      const release = await checkPendingRelease(owner, repo, types);
      assert.equal(release.status, expected);
      if (expected === 'pending') assert.match(release.reasons, new RegExp(pkg));
    });
  });
});

test('detects source paths from every ecosystem without duplicating files', async () => {
  mockManifests({ 'Cargo.toml': '', 'package.json': '{}' });
  mockReleaseComparison(['lib/example.js', 'src/example.rs']);
  const types = await detectProjectTypes(owner, repo);
  const release = await checkPendingRelease(owner, repo, types);
  assert.equal(release.status, 'pending');
  assert.equal(release.reasons, '**Source code changes:**\n- `lib/example.js`\n- `src/example.rs`\n');
});

['rack', 'prettier'].forEach((pkg) => {
  test(`preserves Ruby production detection with a development-only package.json: ${pkg}`, async () => {
    mockManifests({
      Gemfile: "gem 'rack', '3.1.0'",
      'package.json': '{"devDependencies":{"prettier":"3"}}',
    });
    mockReleaseComparison(['Gemfile', 'Gemfile.lock'], [`Bump ${pkg} from 3.0.0 to 3.1.0`]);
    const types = await detectProjectTypes(owner, repo);
    const release = await checkPendingRelease(owner, repo, types);
    assert.equal(release.status, pkg === 'rack' ? 'pending' : 'up-to-date');
    if (pkg === 'rack') assert.equal(release.reasons, '**Dependency updates:**\n- rack 3.0.0 -> 3.1.0');
  });
});
