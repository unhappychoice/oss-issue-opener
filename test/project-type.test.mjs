import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import { checkPendingRelease } from '../dist/checker.js';
import { isProductionDependency } from '../dist/dependency.js';
import { getOctokit, getRepoContents } from '../dist/github.js';
import { detectProjectTypes } from '../dist/project-type.js';
import { commitSha, initMockOctokit, mockCommitFiles } from './helpers/github.mjs';

const owner = 'example';
const repo = 'gemfile-only';

beforeEach(() => {
  mock.restoreAll();
  initMockOctokit('test-token');
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

const mockReleaseComparison = (files, commitMessages = [], bumpPaths = files) => {
  mock.method(getOctokit().repos, 'listReleases', async () => ({
    data: [{ tag_name: 'v1.0.0' }],
  }));
  mock.method(getOctokit().repos, 'get', async () => ({
    data: { default_branch: 'main' },
  }));
  mockCommitFiles(mock, bumpPaths);
  mock.method(getOctokit().repos, 'compareCommits', async () => ({
    data: {
      files: files.map((filename) => ({ filename })),
      commits: commitMessages.map((message) => ({ sha: 'commit', commit: { message } })),
    },
  }));
};

test('detects lib changes as pending releases for a Gemfile-only repository', async () => {
  mockReleaseComparison(['lib/example.rb']);
  const type = await detectProjectTypes(owner, repo);
  const release = await checkPendingRelease(owner, repo, type);
  assert.equal(release.status, 'pending');
  assert.deepEqual(release.changedSources, ['lib/example.rb']);
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
      ], pkg === 'rack' ? ['Gemfile.lock'] : ['package.json']);
      const types = await detectProjectTypes(owner, repo);
      const release = await checkPendingRelease(owner, repo, types);
      assert.equal(release.status, expected);
      if (expected === 'pending') assert.ok(release.dependencyUpdates.some((update) => update.pkg === pkg));
    });
  });
});

test('detects source paths from every ecosystem without duplicating files', async () => {
  mockManifests({ 'Cargo.toml': '', 'package.json': '{}' });
  mockReleaseComparison(['lib/example.js', 'src/example.rs']);
  const types = await detectProjectTypes(owner, repo);
  const release = await checkPendingRelease(owner, repo, types);
  assert.equal(release.status, 'pending');
  assert.deepEqual(release.changedSources, ['lib/example.js', 'src/example.rs']);
});

test('shares the root listing between project detection and the Ruby dependency checker', async () => {
  const rootCalls = [];
  mock.method(getOctokit().repos, 'getContent', async ({ path }) => {
    if (path === '') rootCalls.push(path);
    return {
      data: path === ''
        ? [{ name: 'Gemfile' }]
        : { content: Buffer.from("gem 'rack'\n").toString('base64') },
    };
  });
  mockReleaseComparison(['Gemfile.lock'], ['Bump rack from 3.0.0 to 3.1.0']);

  let rootContents;
  const getContents = () => rootContents ??= getRepoContents(owner, repo);
  const types = await detectProjectTypes(owner, repo, getContents);
  const release = await checkPendingRelease(owner, repo, types, undefined, getContents);

  assert.equal(release.status, 'pending');
  assert.equal(rootCalls.length, 1);
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
    if (pkg === 'rack') assert.deepEqual(release.dependencyUpdates, [{ pkg: 'rack', from: '3.0.0', to: '3.1.0' }]);
  });
});

['Bump', 'chore(deps): bump'].forEach((prefix) => {
  [false, true].forEach((sourceChanged) => {
    test(`unknown ecosystems ignore ${prefix} updates with source changes: ${sourceChanged}`, async () => {
      mockManifests({ 'pyproject.toml': '', 'README.md': '' });
      const files = ['.github/workflows/test.yml', '.pre-commit-config.yaml', 'docs/requirements.txt'];
      if (sourceChanged) files.push('src/main.py');
      mockReleaseComparison(files, [`${prefix} actions/checkout from 6 to 7`]);
      const types = await detectProjectTypes(owner, repo);
      assert.deepEqual(types, ['unknown']);
      assert.deepEqual(await checkPendingRelease(owner, repo, types), sourceChanged ? {
        status: 'pending',
        changedSources: ['src/main.py'],
        dependencyUpdates: [],
        compareUrl: `https://github.com/${owner}/${repo}/compare/${commitSha('tags/v1.0.0')}...${commitSha('heads/main')}`,
      } : { status: 'up-to-date' });
    });
  });
});
