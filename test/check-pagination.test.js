import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate, setTimeout } from 'node:timers/promises';
import { checkCIStatus } from '../dist/checker.js';
import { getCheckRuns, getOctokit, initOctokit } from '../dist/github.js';

const sha = 'a'.repeat(40);

test('starts suite five while suite one is still paginating', async () => {
  initOctokit('test-token');
  const octokit = getOctokit();
  const suiteIds = [1, 2, 3, 4, 5, 6, 7, 8];
  const slowPageStarted = Promise.withResolvers();
  const releaseSlowPage = Promise.withResolvers();
  const started = [];
  octokit.hook.wrap('request', async (_request, options) => {
    const { url } = octokit.request.endpoint.parse(options);
    const respond = (data, headers = {}) => ({ status: 200, url, headers, data });
    const pageUrl = new URL(url);
    if (pageUrl.pathname.endsWith('/check-suites')) {
      return respond({ total_count: 1001, check_suites: suiteIds.map((id) => ({ id })) });
    }

    const [, suiteId] = pageUrl.pathname.match(/^\/repos\/owner\/repo\/check-suites\/(\d+)\/check-runs$/);
    const page = pageUrl.searchParams.get('page') ?? '1';
    if (page === '1') started.push(Number(suiteId));
    if (suiteId === '1' && page === '2') {
      slowPageStarted.resolve();
      await releaseSlowPage.promise;
    }
    pageUrl.searchParams.set('page', '2');
    return respond({
      total_count: suiteId === '1' ? 2 : 1,
      check_runs: [{ name: `${suiteId}-${page}`, status: 'completed', conclusion: 'success' }],
    }, suiteId === '1' && page === '1' ? { link: `<${pageUrl}>; rel="next"` } : {});
  });

  const scan = Array.fromAsync(getCheckRuns('owner', 'repo', sha));
  await Promise.race([slowPageStarted.promise, scan]);
  await setImmediate();
  const startedWhilePaginating = started.slice();
  releaseSlowPage.resolve();
  const results = await scan;
  assert.ok(startedWhilePaginating.includes(5));
  assert.deepEqual(results.flat().map(({ context }) => context),
    ['1-1', '1-2', ...suiteIds.slice(1).map((id) => `${id}-1`)]);
});

test('shares four suite slots across repositories for the full pagination and yields runs in suite order', async () => {
  initOctokit('test-token');
  const octokit = getOctokit();
  const suiteIds = [4, 3, 2, 1];
  let active = 0;
  let peak = 0;
  octokit.hook.wrap('request', async (_request, options) => {
    const { url } = octokit.request.endpoint.parse(options);
    const respond = (data, headers = {}) => ({ status: 200, url, headers, data });
    const pageUrl = new URL(url);
    if (pageUrl.pathname.endsWith('/check-suites')) {
      return respond({ total_count: 1001, check_suites: suiteIds.map((id) => ({ id })) });
    }

    const [, repo, suiteId] = pageUrl.pathname.match(/^\/repos\/owner\/([^/]+)\/check-suites\/(\d+)\/check-runs$/);
    const page = pageUrl.searchParams.get('page') ?? '1';
    if (page === '1') peak = Math.max(peak, ++active);
    await setTimeout(Number(suiteId) * 10);
    if (page === '2') active--;
    pageUrl.searchParams.set('page', '2');
    return respond({
      total_count: 2,
      check_runs: [{ name: `${repo}-${suiteId}-${page}`, status: 'completed', conclusion: 'success' }],
    }, page === '1' ? { link: `<${pageUrl}>; rel="next"` } : {});
  });

  const repos = ['first', 'second'];
  const results = await Promise.all(repos.map((repo) => Array.fromAsync(getCheckRuns('owner', repo, sha))));
  assert.equal(peak, 4);
  assert.deepEqual(results.map((pages) => pages.flat().map(({ context }) => context)),
    repos.map((repo) => suiteIds.flatMap((id) => [`${repo}-${id}-1`, `${repo}-${id}-2`])));
});

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
        ? [{ name: `check-${total}`, url: `https://github.com/owner/repo/actions/runs/${total}`, source: 'check' }]
        : [],
    });
    assert.deepEqual(requests, requestCount === 1 ? [firstUrl] : [firstUrl, nextUrl]);
  });
});

[
  ['reports a failed check on the oldest of 1,001 check suites', false],
  ['preserves an earlier failed check when a later page in its suite fails', true],
].forEach(([name, failLaterPage]) => {
  test(name, async (t) => {
    initOctokit('test-token');
    const octokit = getOctokit();
    t.mock.method(octokit.repos, 'getCombinedStatusForRef', async () => ({ data: { statuses: [] } }));
    const pageError = Object.assign(new Error('Check run page unavailable'), { status: 503 });
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
      if (suiteId !== 1) return respond('check_runs', [success]);
      if (failLaterPage && page === 2) throw pageError;
      const runs = failLaterPage ? [failure, ...Array(100).fill(success)] : [...Array(100).fill(success), failure];
      return respond('check_runs', runs);
    });

    const getHead = async () => ({ status: 'found', head: { sha, treeSha: 'head-tree' } });
    assert.deepEqual(await checkCIStatus('owner', 'repo', getHead), {
      status: 'failure',
      failedChecks: [{ name: failure.name, url: failure.html_url, source: 'check' }],
      ...(failLaterPage ? { endpointErrors: [pageError] } : {}),
    });
  });
});
