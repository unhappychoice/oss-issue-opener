import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { checkPendingRelease } from '../dist/checker.js';
import { compareCommits, getCommitFiles, getOctokit } from '../dist/github.js';
import { buildPendingReleaseIssue } from '../dist/issue.js';
import { commitSha, initMockOctokit, mockCommitFiles } from './helpers/github.mjs';

beforeEach(() => initMockOctokit('test-token'));

const commits = (count) => Array.from({ length: count }, (_, index) => ({
  sha: `commit-${index}`,
  commit: { message: `docs: update documentation ${index}` },
}));

const stubRelease = (t) => {
  const repos = getOctokit().repos;
  t.mock.method(repos, 'listReleases', async () => ({ data: [{ tag_name: 'v1' }] }));
  t.mock.method(repos, 'get', async () => ({ data: { default_branch: 'main' } }));
  return repos;
};

test('detects a production bump after the first 250 commits', async (t) => {
  const repos = stubRelease(t);
  mockCommitFiles(t.mock, ['package-lock.json']);
  const messages = [...commits(250), { sha: 'bump', commit: { message: 'Bump example from 1.0.0 to 2.0.0' } }];
  const compare = t.mock.method(repos, 'compareCommits', async ({ page, per_page }) => ({
    data: {
      ...(page === 1 ? { files: [{ filename: 'package-lock.json' }] } : {}),
      commits: messages.slice((page - 1) * per_page, page * per_page),
    },
  }));
  t.mock.method(repos, 'getContent', async () => ({
    data: { content: Buffer.from(JSON.stringify({ dependencies: { example: '^2.0.0' } })).toString('base64') },
  }));

  assert.deepEqual(await checkPendingRelease('owner', 'repo', 'node'), {
    status: 'pending',
    changedSources: [],
    dependencyUpdates: [{ pkg: 'example', from: '1.0.0', to: '2.0.0' }],
    compareUrl: `https://github.com/owner/repo/compare/${commitSha('tags/v1')}...${commitSha('heads/main')}`,
  });
  assert.deepEqual(compare.mock.calls.map(({ arguments: [params] }) => params),
    [1, 2, 3].map((page) => ({ owner: 'owner', repo: 'repo', base: commitSha('tags/v1'), head: commitSha('heads/main'), per_page: 100, page })));
});

test('detects the original final production bump and links to the scanned commits after the tag and branch move between pages', async (t) => {
  const repos = stubRelease(t);
  const originalHead = commitSha('heads/main');
  const baseSha = commitSha('tags/v1');
  const refs = new Map([['tags/v1', baseSha], ['heads/main', originalHead]]);
  const resolve = t.mock.method(repos, 'getCommit', async ({ ref }) => ({
    data: ref === 'bump'
      ? { files: [{ filename: 'package-lock.json' }] }
      : { sha: refs.get(ref) },
  }));
  const compare = t.mock.method(repos, 'compareCommits', async ({ base, head, page }) => {
    const resolvedBase = refs.get(base) ?? base;
    const resolvedHead = refs.get(head) ?? head;
    if (page === 1) {
      refs.set('tags/v1', commitSha('replacement-tag'));
      refs.set('heads/main', commitSha('replacement-head'));
      return { data: { files: [{ filename: 'package-lock.json' }], commits: commits(100) } };
    }
    return { data: { commits: resolvedBase === baseSha && resolvedHead === originalHead
      ? [{ sha: 'bump', commit: { message: 'Bump example from 1.0.0 to 2.0.0' } }]
      : [] } };
  });
  const manifest = t.mock.method(repos, 'getContent', async () => ({
    data: { content: Buffer.from(JSON.stringify({ dependencies: { example: '^2.0.0' } })).toString('base64') },
  }));

  const result = await checkPendingRelease('owner', 'repo', 'node');
  assert.equal(result.status, 'pending');
  assert.deepEqual(result.changedSources, []);
  assert.deepEqual(result.dependencyUpdates, [{ pkg: 'example', from: '1.0.0', to: '2.0.0' }]);
  const issue = buildPendingReleaseIssue('owner/repo', result.changedSources, result.dependencyUpdates, result.compareUrl);
  assert.equal(issue.body.split('\n').find((line) => line.startsWith('**Diff**:')),
    `**Diff**: https://github.com/owner/repo/compare/${baseSha}...${originalHead}`);
  assert.deepEqual(resolve.mock.calls.map(({ arguments: [{ ref }] }) => ref), ['tags/v1', 'heads/main', 'bump']);
  assert.deepEqual(compare.mock.calls.map(({ arguments: [{ base, head, page }] }) => [base, head, page]),
    [[baseSha, originalHead, 1], [baseSha, originalHead, 2]]);
  assert.deepEqual(manifest.mock.calls.map(({ arguments: [params] }) => params),
    [{ owner: 'owner', repo: 'repo', path: 'package.json', ref: originalHead }]);
});

test('preserves source changes when later pages omit files', async (t) => {
  const repos = stubRelease(t);
  t.mock.method(repos, 'compareCommits', async ({ page }) => ({
    data: page === 1
      ? { files: [{ filename: 'src/index.ts' }], commits: commits(100) }
      : { commits: commits(1) },
  }));

  assert.deepEqual(await checkPendingRelease('owner', 'repo', 'node'), {
    status: 'pending',
    changedSources: ['src/index.ts'],
    dependencyUpdates: [],
    compareUrl: `https://github.com/owner/repo/compare/${commitSha('tags/v1')}...${commitSha('heads/main')}`,
  });
});

test('finishes on an empty page after an exactly full page', async (t) => {
  const compare = t.mock.method(getOctokit().repos, 'compareCommits', async ({ page }) => ({
    data: { commits: page === 1 ? commits(100) : [] },
  }));

  assert.deepEqual(await compareCommits('owner', 'repo', 'v1', 'main'), {
    baseSha: commitSha('v1'),
    headSha: commitSha('main'),
    files: [],
    commits: commits(100).map(({ sha, commit }) => ({ sha, message: commit.message })),
  });
  assert.equal(compare.mock.callCount(), 2);
});

test('propagates failures on subsequent comparison pages', async (t) => {
  const repos = stubRelease(t);
  const failure = new Error('Comparison page failed');
  t.mock.method(repos, 'compareCommits', async ({ page }) => {
    if (page > 1) throw failure;
    return { data: { files: [{ filename: 'src/index.ts' }], commits: commits(100) } };
  });

  await assert.rejects(checkPendingRelease('owner', 'repo', 'node'), (error) => error === failure);
});

const stubCappedComparison = (t, extraFiles = []) => {
  const repos = stubRelease(t);
  t.mock.method(repos, 'compareCommits', async () => ({ data: {
    files: Array.from({ length: 300 }, (_, index) => ({ filename: `docs/${index}.md` })),
    merge_base_commit: { commit: { tree: { sha: 'merge-base-tree' } } },
    commits: [{ commit: { message: 'fix: handle empty input' } }],
  } }));
  const entry = (path, sha) => ({ path, sha, type: 'blob', mode: '100644' });
  const getTree = t.mock.method(getOctokit().git, 'getTree', async ({ tree_sha }) => ({ data: {
    truncated: false,
    tree: [entry('src/unchanged.ts', 'same'),
      ...Array.from({ length: 301 }, (_, index) => entry(`docs/${index}.md`, tree_sha)),
      ...extraFiles.map(([path, base, head]) => entry(path, tree_sha === 'merge-base-tree' ? base : head))
        .filter(({ sha }) => sha)],
  } }));
  return getTree;
};

test('detects source changes omitted from a capped comparison', async (t) => {
  const getTree = stubCappedComparison(t, [['src/index.ts', 'old', 'new']]);
  const result = await checkPendingRelease('owner', 'repo', 'node');
  assert.equal(result.status, 'pending');
  assert.ok(result.changedSources.includes('src/index.ts'));
  assert.ok(!result.changedSources.some((f) => f.includes('unchanged')));
  assert.deepEqual(getTree.mock.calls.map(({ arguments: [params] }) => params),
    ['merge-base-tree', 'head-tree'].map((tree_sha) => ({ owner: 'owner', repo: 'repo', tree_sha, recursive: '1' })));
});

test('establishes that a capped documentation-only comparison is up to date', async (t) => {
  stubCappedComparison(t);
  assert.deepEqual(await checkPendingRelease('owner', 'repo', 'node'), { status: 'up-to-date' });
});

test('detects added and deleted source paths, including renames out of source directories', async (t) => {
  stubCappedComparison(t, [['src/removed.ts', 'old', undefined], ['lib/added.ts', undefined, 'new']]);
  const result = await checkPendingRelease('owner', 'repo', 'node');
  assert.equal(result.status, 'pending');
  assert.ok(result.changedSources.includes('src/removed.ts'));
  assert.ok(result.changedSources.includes('lib/added.ts'));
});

test('propagates tree fallback API failures instead of declaring up to date', async (t) => {
  const getTree = stubCappedComparison(t);
  const failure = new Error('Tree request failed');
  getTree.mock.mockImplementation(async () => { throw failure; });
  await assert.rejects(checkPendingRelease('owner', 'repo', 'node'), (error) => error === failure);
});

test('rejects truncated trees on either side instead of declaring up to date', async (t) => {
  for (const truncatedTree of ['merge-base-tree', 'head-tree']) {
    const getTree = stubCappedComparison(t);
    getTree.mock.mockImplementation(async ({ tree_sha }) => ({
      data: { truncated: tree_sha === truncatedTree, tree: [] },
    }));
    await assert.rejects(checkPendingRelease('owner', 'repo', 'node'), /truncated tree/);
    t.mock.restoreAll();
  }
});

test('rejects missing comparison tree metadata instead of declaring up to date', async (t) => {
  stubCappedComparison(t);
  getOctokit().repos.compareCommits.mock.mockImplementation(async () => ({ data: {
    files: Array.from({ length: 300 }, (_, index) => ({ filename: `docs/${index}.md` })),
    commits: commits(1),
  } }));
  await assert.rejects(checkPendingRelease('owner', 'repo', 'node'), /missing tree SHA/);
});

test('uses the pinned head tree when a capped comparison spans commit pages', async (t) => {
  const getTree = stubCappedComparison(t, [['src/index.ts', 'old', 'new']]);
  const firstPage = (await getOctokit().repos.compareCommits()).data;
  getOctokit().repos.compareCommits.mock.mockImplementation(async ({ page }) => ({ data: page === 1
    ? { ...firstPage, commits: commits(100).map((item) => ({
      ...item, commit: { ...item.commit, tree: { sha: 'intermediate-tree' } },
    })) }
    : { commits: firstPage.commits },
  }));
  assert.equal((await checkPendingRelease('owner', 'repo', 'node')).status, 'pending');
  assert.deepEqual(getTree.mock.calls.map(({ arguments: [params] }) => params.tree_sha),
    ['merge-base-tree', 'head-tree']);
});

test('does not fetch trees for file lists below the comparison limit', async (t) => {
  const repos = stubRelease(t);
  t.mock.method(repos, 'compareCommits', async () => ({ data: {
    files: Array.from({ length: 299 }, (_, index) => ({ filename: `docs/${index}.md` })),
    commits: commits(1),
  } }));
  const getTree = t.mock.method(getOctokit().git, 'getTree', async () => {
    throw new Error('Unexpected tree request');
  });
  assert.deepEqual(await checkPendingRelease('owner', 'repo', 'node'), { status: 'up-to-date' });
  assert.equal(getTree.mock.callCount(), 0);
});

test('retrieves both rename paths from later commit file pages', async (t) => {
  const getCommit = t.mock.method(getOctokit().repos, 'getCommit', async ({ page }) => ({
    headers: page === 1 ? { link: '<https://api.github.com/?page=2>; rel="next"' } : {},
    data: { files: page === 1
      ? Array.from({ length: 100 }, (_, i) => ({ filename: `docs/${i}.md` }))
      : [{ filename: 'docs/old-gemfile.lock', status: 'renamed', previous_filename: 'Gemfile.lock' }] },
  }));
  const paths = await getCommitFiles('owner', 'repo', 'bump');
  assert.equal(paths.length, 102);
  assert.deepEqual(paths.slice(-2), ['docs/old-gemfile.lock', 'Gemfile.lock']);
  assert.deepEqual(getCommit.mock.calls.map(({ arguments: [params] }) => params),
    [1, 2].map((page) => ({ owner: 'owner', repo: 'repo', ref: 'bump', per_page: 100, page })));
});

test('counts renamed files once against the commit API file limit', async (t) => {
  const files = Array.from({ length: 100 }, (_, i) => ({
    filename: `docs/new-${i}.md`,
    status: 'renamed',
    previous_filename: `docs/old-${i}.md`,
  }));
  const getCommit = t.mock.method(getOctokit().repos, 'getCommit', async ({ page }) => ({
    data: { files: page === 16 ? files.slice(0, 1) : files },
    headers: page < 16 ? { link: '<https://api.github.com/>; rel="next"' } : {},
  }));
  assert.equal((await getCommitFiles('owner', 'repo', 'bump')).length, 3002);
  assert.equal(getCommit.mock.callCount(), 16);
});

test('discards commit paths when the API file limit may hide changes', async (t) => {
  const files = Array.from({ length: 100 }, (_, i) => ({ filename: `docs/${i}.md` }));
  const getCommit = t.mock.method(getOctokit().repos, 'getCommit', async () => ({
    data: { files },
    headers: { link: '<https://api.github.com/?page=2>; rel="next"' },
  }));
  assert.deepEqual(await getCommitFiles('owner', 'repo', 'bump'), []);
  assert.equal(getCommit.mock.callCount(), 30);
});
