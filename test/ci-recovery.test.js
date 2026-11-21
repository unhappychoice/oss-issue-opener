import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkCIStatus } from '../dist/checker.js';
import { getOctokit, initOctokit } from '../dist/github.js';
import { buildCIFailureIssue } from '../dist/issue.js';
import { runChecks } from '../dist/runner.js';

const repo = 'owner/project';
const author = 'unhappychoice';
const sha = 'a'.repeat(40);
const checks = [
  { name: 'build', source: 'check', url: '', workflowId: 10 },
  { name: 'lint', source: 'status', url: '' },
];
const body = buildCIFailureIssue(repo, checks).body;
const alert = { number: 1, title: 'Renamed alert', state: 'open', user: { login: author }, labels: ['ci-failure'], body };
const setAutoClose = (t, value) => {
  const previous = process.env.AUTO_CLOSE_CI_ALERTS;
  process.env.AUTO_CLOSE_CI_ALERTS = value;
  t.after(() => {
    if (previous === undefined) delete process.env.AUTO_CLOSE_CI_ALERTS;
    else process.env.AUTO_CLOSE_CI_ALERTS = previous;
  });
};
const passedBuild = {
  name: 'build', status: 'completed', conclusion: 'success',
  app: { slug: 'github-actions' }, check_suite: { id: 200 },
};
const otherBuild = { ...passedBuild, check_suite: { id: 300 } };
const workflows = [
  { check_suite_id: 100, workflow_id: 10 },
  { check_suite_id: 200, workflow_id: 10 },
  { check_suite_id: 300, workflow_id: 20 },
];
const passedLint = { context: 'lint', state: 'success' };

const setup = (t, {
  alerts = [alert], runs = [passedBuild], statuses = [passedLint], checksError, listError, closeError, commentError,
  workflowError, currentAlert = (issue) => issue,
} = {}) => {
  initOctokit('test-token');
  const client = getOctokit();
  const events = [];
  const comments = [];
  let nextCloseError = closeError;
  const open = new Set(alerts.map(({ number }) => number));
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  t.mock.method(client.repos, 'get', async () => ({ data: { default_branch: 'main' } }));
  t.mock.method(client.repos, 'getBranch', async () => ({ data: { commit: { sha, commit: { tree: { sha } } } } }));
  t.mock.method(client.repos, 'getCombinedStatusForRef', async () => ({ data: { statuses } }));
  t.mock.method(client.actions, 'listWorkflowRunsForRepo', async (params) => {
    assert.deepEqual(params, { owner: 'owner', repo: 'project', head_sha: sha, per_page: 100, page: 1 });
    if (workflowError) throw workflowError;
    return { data: { workflow_runs: workflows } };
  });
  t.mock.method(client.checks, 'listSuitesForRef', async () => ({ data: { total_count: 0 } }));
  t.mock.method(client.paginate, 'iterator', async function* () {
    if (checksError) throw checksError;
    yield { data: runs };
  });
  t.mock.method(client, 'paginate', async (endpoint, params) => {
    if (endpoint === client.issues.listComments) return comments;
    assert.equal(endpoint, client.issues.listForRepo);
    assert.equal(params.labels, 'ci-failure');
    assert.equal(params.state, 'open');
    events.push('list');
    if (listError) throw listError;
    return alerts.filter(({ number }) => open.has(number));
  });
  t.mock.method(client.issues, 'createComment', async (params) => {
    if (commentError) throw commentError;
    comments.push({ user: { login: author }, body: params.body });
    events.push(['comment', params]);
  });
  t.mock.method(client.issues, 'get', async (params) => {
    assert.deepEqual(params, { owner: author, repo: 'oss-issue-opener', issue_number: params.issue_number });
    const issue = alerts.find(({ number }) => number === params.issue_number);
    return { data: currentAlert(issue, comments.length) };
  });
  t.mock.method(client.issues, 'update', async (params) => {
    events.push(['close', params]);
    if (nextCloseError) {
      const error = nextCloseError;
      nextCloseError = undefined;
      throw error;
    }
    open.delete(params.issue_number);
  });

  const deps = {
    listOrgRepos: async function* (org) {
      if (org === author) yield { fullName: repo, defaultBranch: 'main' };
    },
    checkCIStatus,
    checkPendingRelease: async () => ({ status: 'no-tag' }),
    createIssuesInBatch: async () => {},
  };
  return { run: (enabled) => runChecks(deps, enabled), events };
};

test('closes only a matching open alert and records the checked commit once', async (t) => {
  setAutoClose(t, 'true');
  const { run, events } = setup(t, { alerts: [
    { ...alert, number: 2, user: { login: 'other' } },
    { ...alert, number: 3, labels: [] },
    { ...alert, number: 4, body: 'Legacy alert' },
    { ...alert, number: 5, body: buildCIFailureIssue('owner/another', checks).body },
    { ...alert, number: 6, pull_request: {} },
    { ...alert, number: 7, body: `${body}\n\nCopied content above` },
    { ...alert, number: 8, body: buildCIFailureIssue(repo, []).body },
    { ...alert, labels: [{ name: 'ci-failure' }] },
  ] });
  await run();
  await run();
  const issue = { owner: author, repo: 'oss-issue-opener', issue_number: 1 };
  assert.deepEqual(events, [
    'list',
    ['comment', { ...issue, body: `CI recovery verified on the default branch at [\`${sha}\`](https://github.com/${repo}/commit/${sha}). All checks recorded in this alert passed.` }],
    ['close', { ...issue, state: 'closed', state_reason: 'completed' }],
    'list',
  ]);
});

[
  ['label removed', { labels: [] }],
  ['metadata removed', { body: 'Edited alert' }],
  ['repository changed', { body: buildCIFailureIssue('owner/another', checks).body }],
  ['unverified check added', { body: buildCIFailureIssue(repo, [
    ...checks, { name: 'deploy', source: 'status', url: '' },
  ]).body }],
  ['already closed', { state: 'closed' }],
  ['author changed', { user: null }],
  ['pull request', { pull_request: {} }],
].forEach(([name, changes]) => {
  [0, 1].forEach((afterComments) => {
    test(`skips remaining recovery writes with ${name} after ${afterComments} comments`, async (t) => {
      const { run, events } = setup(t, {
        currentAlert: (issue, comments) => comments >= afterComments ? { ...issue, ...changes } : issue,
      });
      await run(true);
      assert.deepEqual(events.map((event) => typeof event === 'string' ? event : event[0]),
        afterComments ? ['list', 'comment'] : ['list']);
    });
  });
});

[
  ['missing check', [], [passedLint]],
  ['same job name from a different workflow', [otherBuild], [passedLint]],
  ['same job name without a workflow match', [{ ...passedBuild, check_suite: { id: 400 } }], [passedLint]],
  ['unidentified skipped check sharing a passing name', [
    passedBuild, { ...passedBuild, check_suite: null, conclusion: 'skipped' },
  ], [passedLint]],
  ['pending check', [{ ...passedBuild, status: 'in_progress' }], [passedLint]],
  ['skipped check', [{ ...passedBuild, conclusion: 'skipped' }], [passedLint]],
  ['skipped check sharing a passing name', [passedBuild, { ...passedBuild, conclusion: 'skipped' }], [passedLint]],
  ['same name from a different API', [], [passedLint, { ...passedLint, context: 'build' }]],
  ['unreadable check name', [passedBuild, { ...passedBuild, name: null }], [passedLint]],
  ['unreadable status state', [passedBuild], [passedLint, { context: 'other' }]],
].forEach(([name, runs, statuses]) => {
  test(`leaves an alert open with a ${name}`, async (t) => {
    const { run, events } = setup(t, { runs, statuses });
    await run(true);
    assert.deepEqual(events, ['list']);
  });
});

test('records the workflow identity of a failing job for recovery on a later suite', async (t) => {
  const runs = [{ ...passedBuild, conclusion: 'failure', check_suite: { id: 100 } }];
  const recordedAlert = { ...alert };
  const { run, events } = setup(t, { runs, alerts: [recordedAlert], statuses: [] });
  const result = await checkCIStatus('owner', 'project');
  assert.deepEqual(result.failedChecks, [checks[0]]);
  recordedAlert.body = buildCIFailureIssue(repo, result.failedChecks).body;
  runs[0] = passedBuild;
  await run(true);
  assert.deepEqual(events.map((event) => typeof event === 'string' ? event : event[0]), ['list', 'comment', 'close']);
});

test('leaves an alert open when workflow identity lookup fails', async (t) => {
  const { run, events } = setup(t, { workflowError: new Error('Workflow runs unavailable') });
  await run(true);
  assert.deepEqual(events, ['list']);
});

test('leaves alerts open when a recorded check has no workflow identity', async (t) => {
  const legacyKey = Buffer.from(JSON.stringify(['check', 'build'])).toString('base64url');
  const legacy = { ...alert, number: 2, body: `<!-- oss-issue-opener:ci:v1 ${repo} ${legacyKey} -->` };
  const unidentified = { ...alert, body: buildCIFailureIssue(repo, [
    { name: 'build', source: 'check', url: '' }, checks[1],
  ]).body };
  const { run, events } = setup(t, { alerts: [legacy, unidentified] });
  await run(true);
  assert.deepEqual(events, ['list']);
});

test('leaves an alert open when a CI endpoint cannot be read', async (t) => {
  const { run, events } = setup(t, { checksError: new Error('Check runs unavailable') });
  await assert.rejects(run(true), /Failed 1 maintenance operations/);
  assert.deepEqual(events, ['list']);
});

test('reports an alert lookup failure without closing any alerts', async (t) => {
  const { run, events } = setup(t, { listError: new Error('Alerts unavailable') });
  await assert.rejects(run(true), /Failed 1 maintenance operations/);
  assert.deepEqual(events, ['list']);
});

test('skips alert lookups when automatic closure is disabled', async (t) => {
  setAutoClose(t, 'false');
  const { run, events } = setup(t);
  await run();
  assert.deepEqual(events, []);
});

test('retries a failed close without repeating the recovery comment', async (t) => {
  const { run, events } = setup(t, { closeError: new Error('Update unavailable') });
  await assert.rejects(run(true), /Failed 1 maintenance operations/);
  await run(true);
  assert.deepEqual(events.map((event) => typeof event === 'string' ? event : event[0]),
    ['list', 'comment', 'close', 'list', 'close']);
});

test('leaves the issue open if the recovery comment fails', async (t) => {
  const { run, events } = setup(t, { commentError: new Error('Comment unavailable') });
  await assert.rejects(run(true), /Failed 1 maintenance operations/);
  assert.deepEqual(events, ['list']);
});
