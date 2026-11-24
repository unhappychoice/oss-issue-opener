import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { checkPendingRelease } from '../dist/checker.js';
import { compareCommits, getCommitFiles, getOctokit } from '../dist/github.js';
import { buildPendingReleaseIssue } from '../dist/issue.js';
import { commitSha, initMockOctokit, mockCommitFiles, npmLockResponse } from './helpers/github.mjs';

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
  t.mock.method(repos, 'getContent', async ({ path, ref }) => path === 'package-lock.json'
    ? npmLockResponse(ref, 'v1', { example: '1.0.0' }, { example: '2.0.0' })
    : { data: JSON.stringify({ dependencies: { example: '^2.0.0' } }) });

  assert.deepEqual(await checkPendingRelease('owner', 'repo', 'node'), {
    status: 'pending',
    changedSources: [],
    dependencyUpdates: [{ pkg: 'example', from: '1.0.0', to: '2.0.0' }],
    compareUrl: `https://github.com/owner/repo/compare/${commitSha('refs/tags/v1')}...${commitSha('heads/main')}`,
  });
  assert.deepEqual(compare.mock.calls.map(({ arguments: [params] }) => params),
    [1, 2, 3].map((page) => ({ owner: 'owner', repo: 'repo', base: commitSha('refs/tags/v1'), head: commitSha('heads/main'), per_page: 100, page })));
});

test('detects the original final production bump and links to the scanned commits after the tag and branch move between pages', async (t) => {
  const repos = stubRelease(t);
  const originalHead = commitSha('heads/main');
  const baseSha = commitSha('refs/tags/v1');
  const refs = new Map([['refs/tags/v1', baseSha], ['heads/main', originalHead]]);
  t.mock.method(repos, 'getBranch', async ({ branch }) => ({
    data: { commit: { sha: refs.get(`heads/${branch}`), commit: { tree: { sha: 'head-tree' } } } },
  }));
  const resolve = t.mock.method(repos, 'getCommit', async ({ ref }) => ({
    data: ref === 'bump'
      ? { files: [{ filename: 'package-lock.json' }] }
      : refs.get(ref),
  }));
  const compare = t.mock.method(repos, 'compareCommits', async ({ base, head, page }) => {
    const resolvedBase = refs.get(base) ?? base;
    const resolvedHead = refs.get(head) ?? head;
    if (page === 1) {
      refs.set('refs/tags/v1', commitSha('replacement-tag'));
      refs.set('heads/main', commitSha('replacement-head'));
      return { data: { files: [{ filename: 'package-lock.json' }], commits: commits(100) } };
    }
    return { data: { commits: resolvedBase === baseSha && resolvedHead === originalHead
      ? [{ sha: 'bump', commit: { message: 'Bump example from 1.0.0 to 2.0.0' } }]
      : [] } };
  });
  const manifest = t.mock.method(repos, 'getContent', async ({ path, ref }) => path === 'package-lock.json'
    ? npmLockResponse(ref, 'v1', { example: '1.0.0' }, { example: '2.0.0' })
    : { data: JSON.stringify({ dependencies: { example: '^2.0.0' } }) });

  const result = await checkPendingRelease('owner', 'repo', 'node');
  assert.equal(result.status, 'pending');
  assert.deepEqual(result.changedSources, []);
  assert.deepEqual(result.dependencyUpdates, [{ pkg: 'example', from: '1.0.0', to: '2.0.0' }]);
  const issue = buildPendingReleaseIssue('owner/repo', result.changedSources, result.dependencyUpdates, result.compareUrl);
  assert.equal(issue.body.split('\n').find((line) => line.startsWith('**Diff**:')),
    `**Diff**: https://github.com/owner/repo/compare/${baseSha}...${originalHead}`);
  assert.deepEqual(resolve.mock.calls.map(({ arguments: [{ ref }] }) => ref), ['refs/tags/v1', 'bump']);
  assert.deepEqual(compare.mock.calls.map(({ arguments: [{ base, head, page }] }) => [base, head, page]),
    [[baseSha, originalHead, 1], [baseSha, originalHead, 2]]);
  assert.deepEqual(manifest.mock.calls.map(({ arguments: [{ owner, repo, path, ref }] }) => ({ owner, repo, path, ref })),
    [
      { owner: 'owner', repo: 'repo', path: 'package.json', ref: originalHead },
      { owner: 'owner', repo: 'repo', path: 'package-lock.json', ref: baseSha },
      { owner: 'owner', repo: 'repo', path: 'package-lock.json', ref: originalHead },
    ]);
});

for (const path of ['docs/readme.md', 'src/index.ts', 'Gemfile.lock', null]) {
  test(`fetches only the first comparison page for ${path ?? 'an empty file list'}`, async (t) => {
    const repos = stubRelease(t);
    const messages = commits(250);
    const compare = t.mock.method(repos, 'compareCommits', async ({ page, per_page }) => ({
      data: {
        ...(page === 1 ? { files: path ? [{ filename: path }] : [] } : {}),
        commits: messages.slice((page - 1) * per_page, page * per_page),
      },
    }));

    assert.deepEqual(await checkPendingRelease('owner', 'repo', 'node'), path === 'src/index.ts'
      ? {
        status: 'pending',
        changedSources: [path],
        dependencyUpdates: [],
        compareUrl: `https://github.com/owner/repo/compare/${commitSha('refs/tags/v1')}...${commitSha('heads/main')}`,
      }
      : { status: 'up-to-date' });
    assert.equal(compare.mock.callCount(), 1);
  });
}

test('finishes on an empty page after an exactly full page', async (t) => {
  const compare = t.mock.method(getOctokit().repos, 'compareCommits', async ({ page }) => ({
    data: { commits: page === 1 ? commits(100) : [] },
  }));

  const head = { sha: commitSha('main'), treeSha: 'head-tree' };
  const { getCommitPages, ...comparison } = await compareCommits('owner', 'repo', 'v1', head);
  assert.equal(compare.mock.callCount(), 1);
  assert.deepEqual(comparison, {
    baseSha: commitSha('v1'),
    headSha: commitSha('main'),
    files: [],
  });
  const pages = getCommitPages();
  assert.deepEqual((await pages.next()).value,
    commits(100).map(({ sha, commit }) => ({ sha, message: commit.message })));
  assert.equal(compare.mock.callCount(), 1);
  assert.deepEqual((await pages.next()).value, []);
  assert.equal((await pages.next()).done, true);
  assert.equal(compare.mock.callCount(), 2);
});

test('returns no changed files or commits for matching SHAs without comparing', async (t) => {
  const compare = t.mock.method(getOctokit().repos, 'compareCommits', async () => {
    throw new Error('Unexpected comparison');
  });
  const sha = commitSha('v1');
  const { getCommitPages, ...comparison } = await compareCommits('owner', 'repo', 'v1', { sha, treeSha: 'head-tree' });

  assert.deepEqual(comparison, { baseSha: sha, headSha: sha, files: [] });
  assert.equal((await getCommitPages().next()).done, true);
  assert.equal(compare.mock.callCount(), 0);
});

test('reports an incomplete release investigation when subsequent comparison pages fail', async (t) => {
  const repos = stubRelease(t);
  const failure = new Error('Comparison page failed');
  t.mock.method(repos, 'compareCommits', async ({ page }) => {
    if (page > 1) throw failure;
    return { data: { files: [{ filename: 'package-lock.json' }], commits: commits(100) } };
  });

  assert.deepEqual(await checkPendingRelease('owner', 'repo', 'node'), {
    status: 'incomplete',
    lookupErrors: [failure],
  });
});

const bump = (version) => ({
  sha: `bump-${version}`,
  commit: { message: `Bump example-${version} from 1.0.0 to ${version}.0.0` },
});

const stubProductionDependencies = (t, repos, lookup, versions) => {
  const resolveCommit = repos.getCommit.bind(repos);
  t.mock.method(repos, 'getCommit', async (params) => {
    if (params.page === undefined) return resolveCommit(params);
    await lookup(params.ref);
    return { data: { files: [{ filename: 'package-lock.json' }] } };
  });
  const before = Object.fromEntries(versions.map((version) => [`example-${version}`, '1.0.0']));
  const after = Object.fromEntries(versions.map((version) => [`example-${version}`, `${version}.0.0`]));
  t.mock.method(repos, 'getContent', async ({ path, ref }) => path === 'package-lock.json'
    ? npmLockResponse(ref, 'v1', before, after)
    : { data: JSON.stringify({ dependencies: after }) });
};

test('starts a first-page lookup while the next comparison page is pending and retains the update when it fails', async (t) => {
  const repos = stubRelease(t);
  const nextPage = Promise.withResolvers();
  const failure = new Error('Comparison page failed');
  const lookup = t.mock.fn();
  stubProductionDependencies(t, repos, lookup, [2]);
  const compare = t.mock.method(repos, 'compareCommits', async ({ page }) => {
    if (page === 1) return { data: {
      files: [{ filename: 'package-lock.json' }],
      commits: [bump(2), ...commits(99)],
    } };
    await nextPage.promise;
    throw failure;
  });

  const release = checkPendingRelease('owner', 'repo', 'node');
  await setImmediate();
  const pagesRequested = compare.mock.callCount();
  const lookedUpWhilePagePending = lookup.mock.callCount();
  nextPage.resolve();
  const result = await release;
  assert.equal(pagesRequested, 2);
  assert.equal(lookedUpWhilePagePending, 1);
  assert.equal(result.status, 'pending');
  assert.deepEqual(result.dependencyUpdates, [{ pkg: 'example-2', from: '1.0.0', to: '2.0.0' }]);
  assert.deepEqual(result.lookupErrors, [failure]);
});

test('bounds the candidate backlog and keeps comparison order across batches', async (t) => {
  const repos = stubRelease(t);
  const firstLookup = Promise.withResolvers();
  const lookup = t.mock.fn(async (ref) => {
    if (ref === 'bump-2') await firstLookup.promise;
  });
  const versions = Array.from({ length: 101 }, (_, index) => index + 2);
  stubProductionDependencies(t, repos, lookup, versions);
  const compare = t.mock.method(repos, 'compareCommits', async ({ page }) => ({
    data: page === 1
      ? { files: [{ filename: 'package-lock.json' }], commits: versions.slice(0, 100).map(bump) }
      : { commits: versions.slice(100).map(bump) },
  }));

  const release = checkPendingRelease('owner', 'repo', 'node');
  await setImmediate();
  const pagesWhileBlocked = compare.mock.callCount();
  const lookupsWhileBlocked = lookup.mock.callCount();
  firstLookup.resolve();
  const result = await release;
  assert.equal(pagesWhileBlocked, 1);
  assert.equal(lookupsWhileBlocked, 16);
  assert.equal(compare.mock.callCount(), 2);
  assert.equal(result.status, 'pending');
  assert.deepEqual(result.dependencyUpdates.map(({ to }) => to),
    versions.map((version) => `${version}.0.0`));
});

const blob = (path, sha, mode = '100644') => ({ path, sha, type: 'blob', mode });
const tree = (path, sha) => ({ path, sha, type: 'tree', mode: '040000' });
const numberedFiles = (count, prefix, suffix) => Array.from({ length: count }, (_, index) => ({
  filename: `${prefix}/${index}.${suffix}`,
}));

const stubCappedComparison = (t, trees = {}, files = numberedFiles(300, 'docs', 'md')) => {
  const repos = stubRelease(t);
  t.mock.method(repos, 'compareCommits', async () => ({ data: {
    files,
    merge_base_commit: { commit: { tree: { sha: 'merge-base-tree' } } },
    commits: [{ commit: { message: 'fix: handle empty input' } }],
  } }));
  const entries = new Map(Object.entries({ 'merge-base-tree': [], 'head-tree': [], ...trees }));
  return t.mock.method(getOctokit().git, 'getTree', async ({ tree_sha }) => {
    assert.ok(entries.has(tree_sha), `Unexpected tree request: ${tree_sha}`);
    return { data: { truncated: false, tree: entries.get(tree_sha) } };
  });
};

test('detects omitted source changes without fetching an unchanged subtree', async (t) => {
  const files = numberedFiles(301, 'src', 'ts');
  const getTree = stubCappedComparison(t, {
    'merge-base-tree': [tree('fixtures', 'same-fixtures'), tree('src', 'old-src')],
    'head-tree': [tree('fixtures', 'same-fixtures'), tree('src', 'new-src')],
    'old-src': [blob('unchanged.ts', 'same'), ...files.map((_, i) => blob(`${i}.ts`, 'old'))],
    'new-src': [blob('unchanged.ts', 'same'), ...files.map((_, i) => blob(`${i}.ts`, 'new'))],
  }, files.slice(0, 300));

  const result = await checkPendingRelease('owner', 'repo', 'node');
  assert.equal(result.status, 'pending');
  assert.deepEqual(result.changedSources.toSorted(), files.map(({ filename }) => filename).toSorted());
  assert.deepEqual(getTree.mock.calls.map(({ arguments: [params] }) => params),
    ['merge-base-tree', 'head-tree', 'old-src', 'new-src'].map((tree_sha) => ({ owner: 'owner', repo: 'repo', tree_sha })));
});

test('establishes that a capped documentation-only comparison is up to date', async (t) => {
  stubCappedComparison(t, {
    'head-tree': [tree('docs', 'new-docs')],
    'new-docs': numberedFiles(301, 'docs', 'md').map((_, i) => blob(`${i}.md`, 'new')),
  });
  assert.deepEqual(await checkPendingRelease('owner', 'repo', 'node'), { status: 'up-to-date' });
});

test('detects added and removed subtree paths, file mode changes, and file-to-directory replacements', async (t) => {
  stubCappedComparison(t, {
    'merge-base-tree': [tree('src', 'old-src'), tree('lib', 'shared')],
    'head-tree': [tree('src', 'new-src'), tree('docs', 'shared')],
    'old-src': [blob('script.ts', 'same'), blob('replaced.ts', 'old')],
    'new-src': [blob('script.ts', 'same', '100755'), tree('replaced.ts', 'shared')],
    shared: [tree('nested', 'nested')],
    nested: [blob('index.ts', 'same')],
  });
  const { files } = await compareCommits('owner', 'repo', 'v1', { sha: commitSha('main'), treeSha: 'head-tree' });
  assert.deepEqual(files.toSorted(), [
    'docs/nested/index.ts', 'lib/nested/index.ts', 'src/replaced.ts', 'src/replaced.ts/nested/index.ts', 'src/script.ts',
  ]);
  const calls = getOctokit().git.getTree.mock.calls.map(({ arguments: [{ tree_sha }] }) => tree_sha);
  assert.equal(calls.filter((sha) => sha === 'shared').length, 1);
  assert.equal(calls.filter((sha) => sha === 'nested').length, 1);
});

test('skips fetching identical root trees', async (t) => {
  const getTree = stubCappedComparison(t);
  const { files } = await compareCommits('owner', 'repo', 'v1', { sha: commitSha('main'), treeSha: 'merge-base-tree' });
  assert.deepEqual(files, []);
  assert.equal(getTree.mock.callCount(), 0);
});

test('propagates tree fallback API failures instead of declaring up to date', async (t) => {
  const getTree = stubCappedComparison(t);
  const failure = new Error('Tree request failed');
  getTree.mock.mockImplementation(async () => { throw failure; });
  await assert.rejects(checkPendingRelease('owner', 'repo', 'node'), (error) => error === failure);
});

test('rejects truncated trees on either side instead of declaring up to date', async (t) => {
  for (const truncatedTree of ['merge-base-tree', 'head-tree', 'new-src']) {
    const getTree = stubCappedComparison(t);
    getTree.mock.mockImplementation(async ({ tree_sha }) => ({ data: {
      truncated: tree_sha === truncatedTree,
      tree: tree_sha === 'head-tree' ? [tree('src', 'new-src')] : [],
    } }));
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

for (const field of ['path', 'sha', 'mode', 'type']) {
  test(`rejects a comparison tree entry without ${field}`, async (t) => {
    const getTree = stubCappedComparison(t);
    const entry = tree('src', 'new-src');
    delete entry[field];
    getTree.mock.mockImplementation(async ({ tree_sha }) => ({
      data: { truncated: false, tree: tree_sha === 'head-tree' ? [entry] : [] },
    }));

    await assert.rejects(checkPendingRelease('owner', 'repo', 'node'), {
      message: 'Cannot establish complete comparison: incomplete tree entry',
    });
  });
}

test('uses the pinned head tree to find a dependency change that requires later pages', async (t) => {
  const getTree = stubCappedComparison(t, {
    'merge-base-tree': [blob('package-lock.json', 'old')],
    'head-tree': [blob('package-lock.json', 'new')],
  });
  const compare = getOctokit().repos.compareCommits;
  const { data: firstPage } = await compare();
  compare.mock.resetCalls();
  compare.mock.mockImplementation(async ({ page }) => ({ data: page === 1
    ? { ...firstPage, commits: commits(100).map((item) => ({
      ...item, commit: { ...item.commit, tree: { sha: 'intermediate-tree' } },
    })) }
    : { commits: [{ sha: 'bump', commit: { message: 'Bump example from 1.0.0 to 2.0.0' } }] },
  }));
  mockCommitFiles(t.mock, ['package-lock.json']);
  t.mock.method(getOctokit().repos, 'getContent', async ({ path, ref }) => path === 'package-lock.json'
    ? npmLockResponse(ref, 'v1', { example: '1.0.0' }, { example: '2.0.0' })
    : { data: JSON.stringify({ dependencies: { example: '^2.0.0' } }) });

  const result = await checkPendingRelease('owner', 'repo', 'node');
  assert.equal(result.status, 'pending');
  assert.deepEqual(result.dependencyUpdates, [{ pkg: 'example', from: '1.0.0', to: '2.0.0' }]);
  assert.deepEqual(compare.mock.calls.map(({ arguments: [{ page }] }) => page), [1, 2]);
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

test('rejects commit file lookups when the API file limit may hide changes', async (t) => {
  const files = Array.from({ length: 100 }, (_, i) => ({ filename: `docs/${i}.md` }));
  const getCommit = t.mock.method(getOctokit().repos, 'getCommit', async () => ({
    data: { files },
    headers: { link: '<https://api.github.com/?page=2>; rel="next"' },
  }));
  await assert.rejects(getCommitFiles('owner', 'repo', 'bump'), /reached the 3000-file limit/);
  assert.equal(getCommit.mock.callCount(), 30);
});
