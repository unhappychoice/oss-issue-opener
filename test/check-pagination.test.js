import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkCIStatus } from '../dist/checker.js';
import { getOctokit, initOctokit } from '../dist/github.js';

['failure', 'success'].forEach((conclusion) => {
  test(`reads all check pages when the last check is ${conclusion}`, async (t) => {
    initOctokit('test-token');
    const octokit = getOctokit();
    t.mock.method(octokit.repos, 'get', async () => ({ data: { default_branch: 'main' } }));
    t.mock.method(octokit.repos, 'getCombinedStatusForRef', async () => ({ data: { statuses: [] } }));
    const requests = [];
    const nextUrl = 'https://api.github.com/repos/owner/repo/commits/main/check-runs?page=2';
    const check = (index, result) => ({
      name: `check-${index}`,
      status: 'completed',
      conclusion: result,
      html_url: `https://github.com/owner/repo/actions/runs/${index}`,
    });
    octokit.hook.wrap('request', async (_request, options) => {
      requests.push(options);
      const secondPage = options.url === nextUrl;
      return {
        status: 200,
        url: secondPage ? nextUrl : nextUrl.replace('?page=2', ''),
        headers: secondPage ? {} : { link: `<${nextUrl}>; rel="next"` },
        data: {
          total_count: 31,
          check_runs: secondPage ? [check(31, conclusion)] : Array.from({ length: 30 }, (_, i) => check(i + 1, 'success')),
        },
      };
    });

    assert.deepEqual(await checkCIStatus('owner', 'repo'), {
      status: conclusion,
      failedChecks: conclusion === 'failure'
        ? [{ name: 'check-31', url: 'https://github.com/owner/repo/actions/runs/31' }]
        : [],
    });
    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, nextUrl.replace('?page=2', ''));
    assert.equal(requests[1].url, nextUrl);
  });
});
