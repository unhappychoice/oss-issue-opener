import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { checkPendingRelease } from '../dist/checker.js';
import { getLatestRelease, getOctokit, initOctokit } from '../dist/github.js';

beforeEach(() => initOctokit('test-token'));

const draft = { tag_name: 'v2.0.0', draft: true };
const published = { tag_name: 'v1.0.0', draft: false };

test('reports source changes against the published release when a draft points to HEAD', async (t) => {
  const repos = getOctokit().repos;
  t.mock.method(repos, 'listReleases', async () => ({ data: [draft, published] }));
  t.mock.method(repos, 'get', async () => ({ data: { default_branch: 'main' } }));
  const compare = t.mock.method(repos, 'compareCommits', async ({ base }) => ({ data: {
    files: base === published.tag_name ? [{ filename: 'src/index.ts' }] : [],
    commits: [],
  } }));

  assert.deepEqual(await checkPendingRelease('owner', 'repo', 'node'), {
    status: 'pending',
    reasons: '**Source code changes:**\n- `src/index.ts`\n',
    compareUrl: 'https://github.com/owner/repo/compare/v1.0.0...main',
  });
  assert.equal(compare.mock.calls[0].arguments[0].base, published.tag_name);
});

test('finds a published release on a later page and stops searching', async (t) => {
  const releases = t.mock.method(getOctokit().repos, 'listReleases', async ({ page }) => ({
    data: page === 1 ? Array(100).fill(draft) : [published, draft],
  }));

  assert.equal(await getLatestRelease('owner', 'repo'), published.tag_name);
  assert.deepEqual(releases.mock.calls.map(({ arguments: [params] }) => params),
    [1, 2].map((page) => ({ owner: 'owner', repo: 'repo', per_page: 100, page })));
});

test('keeps prereleases eligible as published releases', async (t) => {
  t.mock.method(getOctokit().repos, 'listReleases', async () => ({
    data: [{ tag_name: 'v2.0.0-beta.1', draft: false, prerelease: true }, published],
  }));

  assert.equal(await getLatestRelease('owner', 'repo'), 'v2.0.0-beta.1');
});

[[], [draft], Array(100).fill(draft)].forEach((firstPage) => {
  test(`falls back to tags after exhausting ${firstPage.length} releases without a published release`, async (t) => {
    const repos = getOctokit().repos;
    const releases = t.mock.method(repos, 'listReleases', async ({ page }) => ({
      data: page === 1 ? firstPage : [],
    }));
    const tags = t.mock.method(repos, 'listTags', async () => ({ data: [{ name: 'v0.9.0' }] }));

    assert.equal(await getLatestRelease('owner', 'repo'), 'v0.9.0');
    assert.equal(releases.mock.callCount(), firstPage.length === 100 ? 2 : 1);
    assert.deepEqual(tags.mock.calls[0].arguments[0], { owner: 'owner', repo: 'repo', per_page: 1 });
  });
});

test('returns null when only drafts and no tags exist', async (t) => {
  const repos = getOctokit().repos;
  t.mock.method(repos, 'listReleases', async () => ({ data: [draft] }));
  t.mock.method(repos, 'listTags', async () => ({ data: [] }));

  assert.equal(await getLatestRelease('owner', 'repo'), null);
});
