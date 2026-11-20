import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkCIStatus } from '../dist/checker.js';
import { getOctokit, initOctokit } from '../dist/github.js';

const sha = 'a'.repeat(40);

[
  { total: 100, conclusion: 'success', requestCount: 1 },
  { total: 101, conclusion: 'failure', requestCount: 2 },
  { total: 101, conclusion: 'success', requestCount: 2 },
  { total: 101, conclusion: 'action_required', requestCount: 2 },
].forEach(({ total, conclusion, requestCount }) => {
  test(`reads ${total} checks with ${requestCount} API call(s) when the last check is ${conclusion}`, async (t) => {
    initOctokit('test-token');
    const octokit = getOctokit();
    t.mock.method(octokit.repos, 'getBranch', async () => ({ data: { commit: { sha, commit: { tree: { sha: 'head-tree' } } } } }));
    t.mock.method(octokit.repos, 'get', async () => ({ data: { default_branch: 'main' } }));
    t.mock.method(octokit.repos, 'getCombinedStatusForRef', async () => ({ data: { statuses: [] } }));
    const requests = [];
    const firstUrl = `https://api.github.com/repos/owner/repo/commits/${sha}/check-runs?per_page=100`;
    const nextUrl = `${firstUrl}&page=2`;
    const check = (index, result) => ({
      name: `check-${index}`,
      status: 'completed',
      conclusion: result,
      html_url: `https://github.com/owner/repo/actions/runs/${index}`,
    });
    octokit.hook.wrap('request', async (_request, options) => {
      const { url } = options;
      requests.push(url);
      const { searchParams } = new URL(url);
      const pageSize = Number(searchParams.get('per_page') ?? 30);
      const page = Number(searchParams.get('page') ?? 1);
      const start = (page - 1) * pageSize;
      const end = Math.min(start + pageSize, total);
      const nextPage = new URL(url);
      nextPage.searchParams.set('page', String(page + 1));
      return {
        status: 200,
        url,
        headers: end < total ? { link: `<${nextPage}>; rel="next"` } : {},
        data: {
          total_count: total,
          check_runs: Array.from({ length: end - start }, (_, i) => {
            const index = start + i + 1;
            return check(index, index === total ? conclusion : 'success');
          }),
        },
      };
    });

    assert.deepEqual(await checkCIStatus('owner', 'repo'), {
      status: conclusion === 'success' ? 'success' : 'failure',
      failedChecks: conclusion !== 'success'
        ? [{ name: `check-${total}`, url: `https://github.com/owner/repo/actions/runs/${total}` }]
        : [],
    });
    assert.deepEqual(requests, requestCount === 1 ? [firstUrl] : [firstUrl, nextUrl]);
  });
});
