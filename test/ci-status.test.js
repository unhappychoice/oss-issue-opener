import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { checkCIStatus } from '../dist/checker.js';
import { getOctokit, initOctokit } from '../dist/github.js';
import { buildCIFailureIssue } from '../dist/issue.js';

const sha = 'a'.repeat(40);

initOctokit('test-token');
beforeEach(() => {
  const { repos } = getOctokit();
  mock.method(repos, 'get', async () => ({ data: { default_branch: 'main' } }));
  mock.method(repos, 'getBranch', async () => ({ data: { commit: { sha, commit: { tree: { sha: 'head-tree' } } } } }));
  mock.method(getOctokit().checks, 'listSuitesForRef', async () => ({ data: { total_count: 0 } }));
});
afterEach(() => mock.restoreAll());

const checkStatus = async (status, conclusion) => {
  const client = getOctokit();
  mock.method(client.repos, 'getCombinedStatusForRef', async () => ({ data: { statuses: [] } }));
  mock.method(client.paginate, 'iterator', async function* (method, params) {
    assert.equal(method, client.checks.listForRef);
    assert.deepEqual(params, { owner: 'owner', repo: 'repo', ref: sha, per_page: 100 });
    yield { data: [{ status, conclusion, name: 'build', html_url: checkUrl }] };
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
      failedChecks: status === 'failure' ? [{ name: 'build', url: checkUrl, source: 'check' }] : [],
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
    mock.method(client.paginate, 'iterator', async function* () { yield { data: [
      { status: 'completed', conclusion: 'success', name: 'build', html_url: checkUrl },
      { status: 'completed', conclusion: 'failure', name: 'codeCOV/project', html_url: checkUrl },
    ] }; });

    assert.deepEqual(await checkCIStatus('owner', 'repo'), {
      status: state === 'success' ? 'success' : 'failure',
      failedChecks: state === 'success' ? [] : [{ name: 'lint', url: checkUrl, source: 'status' }],
    });
  });
});

test('reports incomplete CI and preserves both errors when neither endpoint responds', async () => {
  const client = getOctokit();
  const statusesError = new Error('Commit statuses HTTP 503');
  const checksError = new Error('Check runs HTTP 503');
  mock.method(client.repos, 'getCombinedStatusForRef', async () => { throw statusesError; });
  mock.method(client.paginate, 'iterator', () => { throw checksError; });

  assert.deepEqual(await checkCIStatus('owner', 'repo'), {
    status: 'incomplete',
    failedChecks: [],
    endpointErrors: [statusesError, checksError],
  });
});

test('resolves the failed check workflow when commit statuses are unavailable', async () => {
  const client = getOctokit();
  const statusesError = new Error('Commit statuses HTTP 503');
  mock.method(client.repos, 'getCombinedStatusForRef', async () => { throw statusesError; });
  mock.method(client.paginate, 'iterator', async function* () {
    yield { data: [{
      name: 'build', status: 'completed', conclusion: 'failure', html_url: checkUrl,
      app: { slug: 'github-actions' }, check_suite: { id: 200 },
    }] };
  });
  const workflows = mock.method(client.actions, 'listWorkflowRunsForRepo', async () => ({
    data: { workflow_runs: [{ check_suite_id: 200, workflow_id: 10 }] },
  }));

  assert.deepEqual(await checkCIStatus('owner', 'repo', undefined, true), {
    status: 'failure',
    failedChecks: [{ name: 'build', source: 'check', url: checkUrl, workflowId: 10 }],
    endpointErrors: [statusesError],
  });
  assert.equal(workflows.mock.callCount(), 1);
});

[
  { expected: 'success' },
  { expected: 'pending', lastStatus: 'in_progress' },
  { expected: 'no-ci', codecovOnly: true },
  { expected: 'incomplete', failLater: true },
  { expected: 'failure', failLater: true, conclusion: 'failure' },
].forEach(({ expected, lastStatus = 'completed', codecovOnly, failLater, conclusion = 'success' }) => {
  test(`aggregates multiple check run pages as ${expected}`, async () => {
    const client = getOctokit();
    const pageError = new Error('Later check run page unavailable');
    const statuses = expected === 'failure' ? [{ state: 'error', context: 'lint' }] : [];
    mock.method(client.repos, 'getCombinedStatusForRef', async () => ({ data: { statuses } }));
    mock.method(client.paginate, 'iterator', async function* () {
      yield { data: [
        { name: 'CodeCov/project', status: 'completed', conclusion: 'failure' },
        ...(!codecovOnly ? [{ name: 'build', status: 'completed', conclusion, html_url: checkUrl }] : []),
      ] };
      yield { data: [{ name: codecovOnly ? 'codecov/patch' : 'test', status: lastStatus, conclusion: 'success' }] };
      if (failLater) throw pageError;
    });

    assert.deepEqual(await checkCIStatus('owner', 'repo'), {
      status: expected,
      failedChecks: expected === 'failure' ? [
        { name: 'lint', source: 'status', url: '' },
        { name: 'build', source: 'check', url: checkUrl },
      ] : [],
      ...(failLater ? { endpointErrors: [pageError] } : {}),
    });
  });
});

test('evaluates the same commit when the default branch advances between CI lookups', async () => {
  const client = getOctokit();
  const nextSha = 'b'.repeat(40);
  let branchHead = sha;
  const branch = mock.method(client.repos, 'getBranch', async () => ({
    data: { commit: { sha: branchHead, commit: { tree: { sha: 'head-tree' } } } },
  }));
  const resolve = (ref) => ref === 'main' ? branchHead : ref;
  const statuses = mock.method(client.repos, 'getCombinedStatusForRef', async ({ ref }) => {
    const status = resolve(ref) === sha ? 'success' : 'failure';
    branchHead = nextSha;
    return { data: { statuses: [{ state: status, context: 'lint' }] } };
  });
  const checks = mock.method(client.paginate, 'iterator', async function* (_method, { ref }) { yield { data: [
    { status: 'completed', conclusion: resolve(ref) === sha ? 'success' : 'failure', name: 'build' },
  ] }; });

  assert.deepEqual(await checkCIStatus('owner', 'repo'), {
    status: 'success',
    failedChecks: [],
  });
  assert.deepEqual(branch.mock.calls.map(({ arguments: args }) => args), [
    [{ owner: 'owner', repo: 'repo', branch: 'main' }],
  ]);
  assert.deepEqual(statuses.mock.calls.map(({ arguments: [params] }) => params.ref), [sha]);
  assert.deepEqual(checks.mock.calls.map(({ arguments: [_, params] }) => params.ref), [sha]);
});

test('skips CI lookups when the default branch has no head', async () => {
  const client = getOctokit();
  mock.method(client.repos, 'getBranch', async () => {
    throw Object.assign(new Error('Branch not found'), { status: 404 });
  });
  const statuses = mock.method(client.repos, 'getCombinedStatusForRef', async () => ({}));
  const checks = mock.method(client.paginate, 'iterator', async function* () { yield { data: [] }; });

  assert.deepEqual(await checkCIStatus('owner', 'repo'), {
    status: 'no-ci',
    failedChecks: [],
  });
  assert.equal(statuses.mock.callCount(), 0);
  assert.equal(checks.mock.callCount(), 0);
});

test('reports errors resolving the default branch head', async () => {
  const error = Object.assign(new Error('Service unavailable'), { status: 503 });
  mock.method(getOctokit().repos, 'getBranch', async () => { throw error; });

  await assert.rejects(checkCIStatus('owner', 'repo'), error);
});
