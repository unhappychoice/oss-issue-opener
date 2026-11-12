import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { checkCIStatus } from '../dist/checker.js';
import { getOctokit, initOctokit } from '../dist/github.js';
import { buildCIFailureIssue } from '../dist/issue.js';

initOctokit('test-token');
afterEach(() => mock.restoreAll());

const checkStatus = async (status, conclusion) => {
  const client = getOctokit();
  mock.method(client.repos, 'get', async () => ({ data: { default_branch: 'main' } }));
  mock.method(client.repos, 'getCombinedStatusForRef', async () => ({ data: { statuses: [] } }));
  mock.method(client, 'paginate', async (method, params) => {
    assert.equal(method, client.checks.listForRef);
    assert.deepEqual(params, { owner: 'owner', repo: 'repo', ref: 'main' });
    return [{ status, conclusion, name: 'build', html_url: checkUrl }];
  });
  return checkCIStatus('owner', 'repo');
};

const checkUrl = 'https://github.com/owner/repo/actions/runs/123';
const conclusions = {
  success: 'success',
  neutral: 'success',
  skipped: 'success',
  failure: 'failure',
  timed_out: 'failure',
  action_required: 'failure',
  cancelled: 'failure',
  stale: 'failure',
  startup_failure: 'failure',
};

Object.entries(conclusions).forEach(([conclusion, status]) => {
  test(`completed ${conclusion} is classified as ${status}`, async () => {
    assert.deepEqual(await checkStatus('completed', conclusion), {
      status,
      failedChecks: status === 'failure' ? [{ name: 'build', url: checkUrl }] : [],
    });
  });
});

['queued', 'in_progress', 'waiting', 'pending', 'requested'].forEach((status) => {
  [null, 'action_required', 'success'].forEach((conclusion) => {
    test(`${status} stays pending with conclusion ${conclusion}`, async () => {
      assert.deepEqual(await checkStatus(status, conclusion), { status: 'pending', failedChecks: [] });
    });
  });
});

[null, 'unknown'].forEach((conclusion) => {
  test(`completed checks with conclusion ${conclusion} stay pending`, async () => {
    assert.deepEqual(await checkStatus('completed', conclusion), { status: 'pending', failedChecks: [] });
  });
});

test('action_required includes the failed check name and URL in the notification', async () => {
  const result = await checkStatus('completed', 'action_required');
  assert.equal(result.status, 'failure');
  const issue = buildCIFailureIssue('owner/repo', result.failedChecks);
  assert.equal(issue.type, 'ci-failure');
  assert.ok(issue.body.includes(`- [build](${checkUrl})`));
});

['failure', 'error', 'success'].forEach((state) => {
  test(`aggregates ${state} commit status with successful and Codecov checks`, async () => {
    const client = getOctokit();
    mock.method(client.repos, 'getCombinedStatusForRef', async () => ({
      data: { statuses: [
        { state, context: 'lint', target_url: checkUrl },
        { state: 'error', context: 'Codecov/patch', target_url: checkUrl },
      ] },
    }));
    mock.method(client, 'paginate', async () => [
      { status: 'completed', conclusion: 'success', name: 'build', html_url: checkUrl },
      { status: 'completed', conclusion: 'failure', name: 'codeCOV/project', html_url: checkUrl },
    ]);

    assert.deepEqual(await checkCIStatus('owner', 'repo', async () => 'main'), {
      status: state === 'success' ? 'success' : 'failure',
      failedChecks: state === 'success' ? [] : [{ name: 'lint', url: checkUrl }],
    });
  });
});
