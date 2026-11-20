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
    t.mock.method(octokit.repos, 'getBranch', async () => ({ data: { commit: { sha } } }));
    t.mock.method(octokit.repos, 'get', async () => ({ data: { default_branch: 'main' } }));
    t.mock.method(octokit.repos, 'getCombinedStatusForRef', async () => ({ data: { statuses: [] } }));
    t.mock.method(octokit.checks, 'listSuitesForRef', async () => ({ data: { total_count: 1000 } }));
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

test('reports a failed check on the oldest of 1,001 check suites', async (t) => {
  initOctokit('test-token');
  const octokit = getOctokit();
  t.mock.method(octokit.repos, 'getBranch', async () => ({ data: { commit: { sha } } }));
  t.mock.method(octokit.repos, 'getCombinedStatusForRef', async () => ({ data: { statuses: [] } }));
  const suites = Array.from({ length: 1001 }, (_, i) => ({ id: 1001 - i }));
  const success = { name: 'build', status: 'completed', conclusion: 'success' };
  const failure = {
    name: 'oldest-build', status: 'completed', conclusion: 'failure',
    html_url: 'https://github.com/owner/repo/actions/runs/1',
  };

  octokit.hook.wrap('request', async (_request, options) => {
    const { url } = octokit.request.endpoint.parse(options);
    const next = new URL(url);
    const size = Number(next.searchParams.get('per_page'));
    const page = Number(next.searchParams.get('page') ?? 1);
    const start = (page - 1) * size;
    const end = start + size;
    const commit = `/repos/owner/repo/commits/${sha}`;
    const respond = (key, items) => {
      next.searchParams.set('page', String(page + 1));
      return {
        status: 200, url,
        headers: end < items.length ? { link: `<${next}>; rel="next"` } : {},
        data: { total_count: items.length, [key]: items.slice(start, end) },
      };
    };

    if (next.pathname === `${commit}/check-suites`) return respond('check_suites', suites);
    if (next.pathname === `${commit}/check-runs`) return respond('check_runs', suites.slice(0, 1000).map(() => success));
    const suiteId = Number(next.pathname.match(/^\/repos\/owner\/repo\/check-suites\/(\d+)\/check-runs$/)?.[1]);
    assert.ok(suiteId >= 1 && suiteId <= 1001, `Unexpected request: ${url}`);
    return respond('check_runs', suiteId === 1 ? [...Array(100).fill(success), failure] : [success]);
  });

  assert.deepEqual(await checkCIStatus('owner', 'repo', async () => 'main'), {
    status: 'failure',
    failedChecks: [{ name: failure.name, url: failure.html_url }],
  });
});
