import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkPendingRelease } from '../dist/checker.js';
import { compareCommits, initOctokit } from '../dist/github.js';
import { commitSha } from './helpers/github.mjs';

const shaMediaType = 'application/vnd.github.sha';

for (const [tag, atHead] of [['v1-annotated', true], ['v1-lightweight', false]]) {
  test(`requests only the commit SHA for ${tag}`, async (t) => {
    const baseSha = commitSha('release-commit');
    const head = { sha: atHead ? baseSha : commitSha('head-commit'), treeSha: 'head-tree' };
    const basePath = `/repos/owner/repo/commits/${encodeURIComponent(`refs/tags/${tag}`)}`;
    const comparePath = `/repos/owner/repo/compare/${baseSha}...${head.sha}`;
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (url, { headers }) => {
      const { pathname } = new URL(url);
      requests.push(pathname);
      if (pathname === '/repos/owner/repo/releases') return Response.json([{ tag_name: tag }]);
      if (pathname === basePath) {
        assert.equal(new Headers(headers).get('accept'), shaMediaType);
        return new Response(baseSha, { headers: { 'content-type': `${shaMediaType}; charset=utf-8` } });
      }
      assert.equal(pathname, comparePath);
      return Response.json({ files: [{ filename: 'src/index.ts' }], commits: [] });
    });
    initOctokit('test-token');

    assert.deepEqual(await checkPendingRelease('owner', 'repo', 'node', async () => ({ status: 'found', head })),
      atHead ? { status: 'up-to-date' } : {
        status: 'pending',
        changedSources: ['src/index.ts'],
        dependencyUpdates: [],
        compareUrl: `https://github.com/owner/repo/compare/${baseSha}...${head.sha}`,
      });
    assert.deepEqual(requests, ['/repos/owner/repo/releases', basePath, ...(atHead ? [] : [comparePath])]);
  });
}

test('rejects an unexpected JSON response when resolving a release tag', async (t) => {
  const sha = commitSha('release-commit');
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ sha }));
  initOctokit('test-token');

  await assert.rejects(compareCommits('owner', 'repo', 'refs/tags/v1', { sha, treeSha: 'head-tree' }),
    { message: 'Expected a commit SHA for owner/repo@refs/tags/v1' });
  assert.equal(fetch.mock.callCount(), 1);
});
