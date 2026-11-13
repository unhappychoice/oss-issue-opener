import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkCIStatus } from '../dist/checker.js';
import { getOctokit, initOctokit } from '../dist/github.js';

['failure', 'success', 'pending'].forEach((state) => {
  test(`reads all commit status pages when the last status is ${state}`, async (t) => {
    initOctokit('test-token');
    const octokit = getOctokit();
    t.mock.method(octokit, 'paginate', async () => []);
    const requests = [];
    const status = (index, result) => ({
      state: result,
      context: `status-${index}`,
      target_url: `https://ci.example.com/builds/${index}`,
    });
    octokit.hook.wrap('request', async (_request, options) => {
      requests.push(options);
      const secondPage = options.page === 2;
      return {
        status: 200,
        url: 'https://api.github.com/repos/owner/repo/commits/main/status',
        headers: secondPage ? {} : {
          link: '<https://api.github.com/repos/owner/repo/commits/main/status?per_page=100&page=2>; rel="next"',
        },
        data: {
          state,
          total_count: 101,
          url: 'https://api.github.com/repos/owner/repo/commits/main/status',
          statuses: secondPage ? [status(101, state)]
            : Array.from({ length: 100 }, (_, i) => status(i + 1, 'success')),
        },
      };
    });

    assert.deepEqual(await checkCIStatus('owner', 'repo', async () => 'main'), {
      status: state,
      failedChecks: state === 'failure'
        ? [{ name: 'status-101', url: 'https://ci.example.com/builds/101' }]
        : [],
    });
    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map(({ page, per_page }) => ({ page, per_page })), [
      { page: 1, per_page: 100 },
      { page: 2, per_page: 100 },
    ]);
    requests.forEach(({ url }) => assert.equal(url, '/repos/{owner}/{repo}/commits/{ref}/status'));
  });
});
