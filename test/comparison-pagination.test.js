import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { checkPendingRelease } from '../dist/checker.js';
import { compareCommits, getOctokit, initOctokit } from '../dist/github.js';

beforeEach(() => initOctokit('test-token'));

const commits = (count) => Array.from({ length: count }, (_, index) => ({
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
  const messages = [...commits(250), { commit: { message: 'Bump example from 1.0.0 to 2.0.0' } }];
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
    reasons: '**Dependency updates:**\n- example 1.0.0 -> 2.0.0',
    compareUrl: 'https://github.com/owner/repo/compare/v1...main',
  });
  assert.deepEqual(compare.mock.calls.map(({ arguments: [params] }) => params),
    [1, 2, 3].map((page) => ({ owner: 'owner', repo: 'repo', base: 'v1', head: 'main', per_page: 100, page })));
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
    reasons: '**Source code changes:**\n- `src/index.ts`\n',
    compareUrl: 'https://github.com/owner/repo/compare/v1...main',
  });
});

test('finishes on an empty page after an exactly full page', async (t) => {
  const compare = t.mock.method(getOctokit().repos, 'compareCommits', async ({ page }) => ({
    data: { commits: page === 1 ? commits(100) : [] },
  }));

  assert.deepEqual(await compareCommits('owner', 'repo', 'v1', 'main'), {
    files: [],
    commitMessages: commits(100).map(({ commit }) => commit.message),
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
    commits: [{ commit: { message: 'fix: handle empty input', tree: { sha: 'head-tree' } } }],
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
  assert.match(result.reasons, /`src\/index.ts`/);
  assert.doesNotMatch(result.reasons, /unchanged/);
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
  assert.match(result.reasons, /`src\/removed.ts`/);
  assert.match(result.reasons, /`lib\/added.ts`/);
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

test('uses the final commit tree when a capped comparison spans commit pages', async (t) => {
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
