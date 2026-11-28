import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkCIStatus } from '../dist/checker.js';
import { getOctokit, initOctokit } from '../dist/github.js';
import { buildCIFailureIssue, createIssuesInBatch } from '../dist/issue.js';
import { runChecks } from '../dist/runner.js';

const repo = 'owner/project';
const issueOwner = 'unhappychoice';
const author = 'alert-maintainer';
const sha = 'a'.repeat(40);
const checks = [
  { name: 'build', source: 'check', url: '', workflowId: 10 },
  { name: 'lint', source: 'status', url: '', publisherId: 42 },
];
const body = buildCIFailureIssue(repo, checks).body;
const recoveryComment = `CI recovery verified on the default branch at [\`${sha}\`](https://github.com/${repo}/commit/${sha}). All checks recorded in this alert passed.`;
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
const passedLint = { context: 'lint', state: 'success', creator: { login: 'ci-bot', id: 42 } };

const setup = (t, {
  alerts = [alert], runs = [passedBuild], statuses = [passedLint], checksError, listError, closeError, commentError,
  persistIssues = false, workflowError, authError, login = author, existingComments = [], currentAlert = (issue) => issue, staleListing = false,
  getHead = () => sha,
} = {}) => {
  initOctokit('test-token');
  const client = getOctokit();
  const events = [];
  const comments = [...existingComments];
  const created = [];
  let nextCloseError = closeError;
  const open = new Set(alerts.map(({ number }) => number));
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  const getAuthenticated = t.mock.method(client.users, 'getAuthenticated', async () => {
    if (authError) throw authError;
    return { data: { login } };
  });
  t.mock.method(client.repos, 'get', async () => ({ data: { default_branch: 'main' } }));
  t.mock.method(client.repos, 'getBranch', async () => {
    const head = getHead(comments.length);
    return { data: { commit: { sha: head, commit: { tree: { sha } } } } };
  });
  t.mock.method(client.repos, 'listCommitStatusesForRef', async () => ({ data: statuses }));
  const workflowRuns = t.mock.method(client.actions, 'listWorkflowRunsForRepo', async (params) => {
    assert.deepEqual(params, { owner: 'owner', repo: 'project', head_sha: sha, per_page: 100, page: 1 });
    if (workflowError) throw workflowError;
    return { data: { workflow_runs: workflows } };
  });
  t.mock.method(client.checks, 'listSuitesForRef', async () => ({ data: { total_count: 0 } }));
  t.mock.method(client.paginate, 'iterator', async function* () {
    yield { data: runs };
    if (checksError) throw checksError;
  });
  t.mock.method(client, 'paginate', async (endpoint, params) => {
    if (endpoint === client.issues.listComments) return comments;
    assert.equal(endpoint, client.issues.listForRepo);
    assert.equal(params.labels, 'ci-failure');
    assert.equal(params.state, 'open');
    events.push('list');
    if (listError) throw listError;
    return staleListing ? alerts : alerts.filter(({ number }) => open.has(number));
  });
  t.mock.method(client.issues, 'create', async ({ title, body, labels }) => {
    const issue = { ...alert, number: alerts.length + 1, title, body, labels };
    alerts.push(issue);
    open.add(issue.number);
    return { data: issue };
  });
  t.mock.method(client.issues, 'createComment', async (params) => {
    if (commentError) throw commentError;
    comments.push({ user: { login: author }, body: params.body });
    events.push(['comment', params]);
  });
  t.mock.method(client.issues, 'get', async (params) => {
    assert.deepEqual(params, { owner: issueOwner, repo: 'oss-issue-opener', issue_number: params.issue_number });
    const issue = alerts.find(({ number }) => number === params.issue_number);
    const current = open.has(issue.number) ? issue : { ...issue, state: 'closed' };
    return { data: currentAlert(current, comments.length) };
  });
  t.mock.method(client.issues, 'update', async (params) => {
    if (params.body !== undefined) {
      alerts.find(({ number }) => number === params.issue_number).body = params.body;
      events.push(['update', params]);
      return;
    }
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
      if (org === issueOwner) yield { fullName: repo, defaultBranch: 'main' };
    },
    checkCIStatus,
    checkPendingRelease: async () => ({ status: 'no-tag' }),
    createIssuesInBatch: persistIssues ? createIssuesInBatch : async (issues) => { created.push(...issues); },
  };
  return { run: (enabled) => runChecks(deps, enabled), events, created, getAuthenticated, workflowRuns };
};

test('closes only a matching open alert and records the checked commit once', async (t) => {
  setAutoClose(t, 'true');
  const { run, events, getAuthenticated } = setup(t, { alerts: [
    { ...alert, number: 2, user: { login: issueOwner } },
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
  assert.equal(getAuthenticated.mock.callCount(), 2);
  const issue = { owner: issueOwner, repo: 'oss-issue-opener', issue_number: 1 };
  assert.deepEqual(events, [
    'list',
    ['comment', { ...issue, body: recoveryComment }],
    ['close', { ...issue, state: 'closed', state_reason: 'completed' }],
    'list',
  ]);
});

[
  ['the head advances before the recovery comment', 0, () => 'b'.repeat(40), false],
  ['the head advances after the recovery comment', 1, () => 'b'.repeat(40), false],
  ['the head is missing before the recovery comment', 0, () => { throw Object.assign(new Error('Not found'), { status: 404 }); }, false],
  ['the head lookup fails after the recovery comment', 1, () => { throw new Error('Branch lookup unavailable'); }, true],
].forEach(([scenario, afterComments, changedHead, lookupFails]) => {
  test(`leaves the alert open when ${scenario}`, async (t) => {
    let recoveryDetected = false;
    const { run, events } = setup(t, {
      currentAlert: (issue) => {
        recoveryDetected = true;
        return issue;
      },
      getHead: (comments) => recoveryDetected && comments >= afterComments ? changedHead() : sha,
    });
    if (lookupFails) await assert.rejects(run(true), /Failed 1 maintenance operations/);
    else await run(true);
    assert.deepEqual(events.map((event) => Array.isArray(event) ? event[0] : event),
      afterComments ? ['list', 'comment'] : ['list']);
  });
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
  ['neutral check', [{ ...passedBuild, conclusion: 'neutral' }], [passedLint]],
  ['skipped check sharing a passing name', [passedBuild, { ...passedBuild, conclusion: 'skipped' }], [passedLint]],
  ['same name from a different API', [], [passedLint, { ...passedLint, context: 'build' }]],
  ['unreadable check name', [passedBuild, { ...passedBuild, name: null }], [passedLint]],
  ['status without a publisher', [passedBuild], [{ ...passedLint, creator: null }]],
  ['status with an invalid publisher ID', [passedBuild], [{ ...passedLint, creator: { id: 0 } }]],
  ['unreadable status context', [passedBuild], [passedLint, { ...passedLint, context: null }]],
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
  const { run, events, created, workflowRuns } = setup(t, { runs, alerts: [recordedAlert], statuses: [] });
  await run(false);
  assert.equal(workflowRuns.mock.callCount(), 1);
  assert.equal(created.length, 1);
  assert.equal(created[0].body, buildCIFailureIssue(repo, [checks[0]]).body);
  recordedAlert.body = created[0].body;
  runs[0] = passedBuild;
  await run(true);
  assert.deepEqual(events.map((event) => typeof event === 'string' ? event : event[0]), ['list', 'comment', 'close']);
});

test('closes after the original status publisher reports success under a new login', async (t) => {
  const statuses = [{ ...passedLint, state: 'failure' }];
  const recordedAlert = { ...alert };
  const { run, events } = setup(t, { statuses, alerts: [recordedAlert] });
  const result = await checkCIStatus('owner', 'project');
  assert.deepEqual(result.failedChecks, [checks[1]]);
  recordedAlert.body = buildCIFailureIssue(repo, result.failedChecks).body;

  statuses[0] = { ...passedLint, creator: { ...passedLint.creator, id: 43 } };
  statuses.push(passedLint);
  await run(true);
  assert.deepEqual(events, ['list']);

  statuses.unshift({ ...passedLint, creator: { ...passedLint.creator, login: 'renamed-bot' } });
  await run(true);
  assert.deepEqual(events.map((event) => Array.isArray(event) ? event[0] : event),
    ['list', 'list', 'comment', 'close']);
});

test('leaves context-only alerts and failures without a valid publisher open', async (t) => {
  const contextOnlyKey = Buffer.from(JSON.stringify(['status', 'lint'])).toString('base64url');
  const legacy = { ...alert, body: `<!-- oss-issue-opener:ci:v1 ${repo} ${contextOnlyKey} -->` };
  const statuses = [{ ...passedLint, state: 'failure', creator: null }];
  const recordedAlert = { ...alert, number: 2 };
  const { run, events } = setup(t, { statuses, alerts: [legacy, recordedAlert] });
  const result = await checkCIStatus('owner', 'project');
  assert.equal(result.status, 'failure');
  recordedAlert.body = buildCIFailureIssue(repo, result.failedChecks).body;
  assert.match(recordedAlert.body, /- lint/);

  statuses[0] = passedLint;
  await run(true);
  assert.deepEqual(events, ['list']);
});

test('closes an alert recorded with a legacy mixed-case status context when the publisher succeeds', async (t) => {
  const legacyKey = Buffer.from(JSON.stringify(['status', 'CI/Lint', 42])).toString('base64url');
  const legacy = { ...alert, body: `<!-- oss-issue-opener:ci:v1 ${repo} ${legacyKey} -->` };
  const statuses = [{ context: 'ci/lint', state: 'success', creator: { login: 'ci-bot', id: 42 } }];
  const { run, events } = setup(t, { alerts: [legacy], statuses });
  await run(true);
  assert.deepEqual(events.map((event) => Array.isArray(event) ? event[0] : event),
    ['list', 'comment', 'close']);
});

test('leaves a legacy mixed-case alert open when a different publisher succeeds', async (t) => {
  const legacyKey = Buffer.from(JSON.stringify(['status', 'CI/Lint', 42])).toString('base64url');
  const legacy = { ...alert, body: `<!-- oss-issue-opener:ci:v1 ${repo} ${legacyKey} -->` };
  const statuses = [{ context: 'ci/lint', state: 'success', creator: { login: 'other-bot', id: 43 } }];
  const { run, events } = setup(t, { alerts: [legacy], statuses });
  await run(true);
  assert.deepEqual(events, ['list']);
});

test('tolerates an unparsable recorded check key without closing the alert', async (t) => {
  const legacy = { ...alert, body: `<!-- oss-issue-opener:ci:v1 ${repo} not-a-valid-key -->` };
  const { run, events } = setup(t, { alerts: [legacy] });
  await run(true);
  assert.deepEqual(events, ['list']);
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

test('keeps an alert from a partial check scan open after the recorded job passes', async (t) => {
  const partial = setup(t, {
    alerts: [],
    runs: [{ ...passedBuild, conclusion: 'failure', check_suite: { id: 100 } }],
    statuses: [],
    checksError: new Error('Later check page unavailable'),
  });
  await assert.rejects(partial.run(true), /Failed 1 maintenance operations/);
  assert.equal(partial.workflowRuns.mock.callCount(), 1);
  assert.equal(partial.created.length, 1);
  const [{ body: partialBody }] = partial.created;
  assert.match(partialBody, /- build/);
  assert.doesNotMatch(partialBody, /oss-issue-opener:ci:v1/);

  const recovered = setup(t, { alerts: [{ ...alert, body: partialBody }], statuses: [] });
  await recovered.run(true);
  assert.deepEqual(recovered.events, ['list']);
});

test('reports an alert lookup failure without closing any alerts', async (t) => {
  const { run, events } = setup(t, { listError: new Error('Alerts unavailable') });
  await assert.rejects(run(true), /Failed 1 maintenance operations/);
  assert.deepEqual(events, ['list']);
});

test('skips alert lookups when automatic closure is disabled', async (t) => {
  setAutoClose(t, 'false');
  const { run, events, getAuthenticated, workflowRuns } = setup(t, { statuses: [] });
  await run();
  assert.deepEqual(events, []);
  assert.equal(getAuthenticated.mock.callCount(), 0);
  assert.equal(workflowRuns.mock.callCount(), 0);
});

test('leaves alerts open when the authenticated account cannot be resolved', async (t) => {
  const { run, events } = setup(t, { authError: new Error('Authenticated user unavailable') });
  await assert.rejects(run(true), /Failed 1 maintenance operations/);
  assert.deepEqual(events, ['list']);
});

test('leaves alerts open when the authenticated account has no login', async (t) => {
  const { run, events } = setup(t, { login: null });
  await assert.rejects(run(true), /Failed 1 maintenance operations/);
  assert.deepEqual(events, ['list']);
});

test('a queued scan skips a closed alert returned by a stale listing at the same commit', async (t) => {
  const { run, events } = setup(t, { staleListing: true });

  await run(true);
  await run(true);

  assert.deepEqual(events.map((event) => Array.isArray(event) ? event[0] : event), [
    'list', 'comment', 'close', 'list',
  ]);
});

test('retries a failed close without repeating the recovery comment', async (t) => {
  const { run, events } = setup(t, {
    closeError: new Error('Update unavailable'),
    existingComments: [{ user: { login: issueOwner }, body: recoveryComment }],
  });
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

test('skips workflow lookup for Codecov-only pages even when the repository has an alert', async (t) => {
  const { run, events, workflowRuns } = setup(t, {
    runs: [{ ...passedBuild, name: 'Codecov/project', conclusion: 'failure' }],
    statuses: [],
  });
  await run(true);
  assert.deepEqual(events, ['list']);
  assert.equal(workflowRuns.mock.callCount(), 0);
  assert.ok(console.log.mock.calls.some(({ arguments: [message] }) => message.includes('CI: no-ci')));
});

test('skips workflow lookup when the only alert is for another repository', async (t) => {
  const { run, events, workflowRuns } = setup(t, {
    alerts: [{ ...alert, body: buildCIFailureIssue('owner/another', checks).body }],
  });
  await run(true);
  assert.deepEqual(events, ['list']);
  assert.equal(workflowRuns.mock.callCount(), 0);
});

test('skips recovery workflow lookup and leaves the issue untouched when the only alert belongs to another author', async (t) => {
  const { run, events, workflowRuns } = setup(t, {
    alerts: [{ ...alert, user: { login: 'other-author' } }],
  });
  await run(true);
  assert.deepEqual(events, ['list']);
  assert.equal(workflowRuns.mock.callCount(), 0);
});

test('reports a failure when workflow lookup fails and keeps the resulting alert open', async (t) => {
  const runs = [{ ...passedBuild, conclusion: 'failure' }];
  const { run, events, created, workflowRuns } = setup(t, {
    alerts: [], runs, statuses: [], workflowError: new Error('Workflow runs unavailable'),
  });
  await run(false);
  assert.equal(workflowRuns.mock.callCount(), 1);
  assert.equal(created.length, 1);
  assert.equal(created[0].body, buildCIFailureIssue(repo, [{ name: 'build', source: 'check', url: '' }]).body);

  const recovered = setup(t, { alerts: [{ ...alert, body: created[0].body }] });
  await recovered.run(true);
  assert.deepEqual(events, []);
  assert.deepEqual(recovered.events, ['list']);
  assert.equal(recovered.workflowRuns.mock.callCount(), 0);
});

test('skips workflow lookup for passing Actions jobs when only a commit status fails', async (t) => {
  const failedLint = { ...passedLint, state: 'failure' };
  const { run, created, workflowRuns } = setup(t, { statuses: [failedLint] });
  await run(true);
  assert.equal(workflowRuns.mock.callCount(), 0);
  assert.equal(created.length, 1);
  assert.equal(created[0].body, buildCIFailureIssue(repo, [checks[1]]).body);
});

test('preserves an edited footer and closes only after every recorded check passes', async (t) => {
  const alerts = [];
  const runs = [{ ...passedBuild, conclusion: 'failure' }];
  const lint = { ...passedBuild, name: 'lint' };
  const { run, events } = setup(t, { alerts, runs, statuses: [], persistIssues: true });

  runs.push(lint);
  await run(true);
  assert.equal(alerts.length, 1);
  const editedBody = alerts[0].body.replace('**Actions**', '**Workflow history**');
  const visibleBody = (body) => body.slice(0, body.lastIndexOf('\n'));
  alerts[0].body = editedBody;
  runs.splice(0, 2, passedBuild, { ...lint, conclusion: 'failure' });
  await run(false);
  alerts[0].title = 'Renamed CI alert';
  await run(true);
  assert.equal(alerts.length, 1);
  assert.notEqual(alerts[0].body, editedBody);
  assert.equal(visibleBody(alerts[0].body), visibleBody(editedBody));
  assert.equal(events.filter((event) => event[0] === 'update').length, 1);

  runs[1] = { ...lint, conclusion: 'skipped' };
  await run(true);
  assert.equal(events.some((event) => event[0] === 'close'), false);

  runs[1] = lint;
  await run(true);
  assert.equal(events.filter((event) => event[0] === 'close').length, 1);
});

test('keeps a near-limit edited alert open when its complete recovery marker cannot fit', async (t) => {
  const body = buildCIFailureIssue(repo, [checks[0]]).body.replace('**Actions**', '**Workflow history**');
  const note = 'x'.repeat(65_536 - body.length - 1) + '\n';
  const alerts = [{ ...alert, body: note + body }];
  const statuses = [{ ...passedLint, state: 'failure' }];
  const { run, events } = setup(t, { alerts, statuses, persistIssues: true });

  await run(true);
  const prefix = body.slice(0, body.lastIndexOf('\n') + 1);
  assert.equal(alerts[0].body, note + prefix + `<!-- oss-issue-opener:ci:v1 ${repo} -->`);

  statuses.length = 0;
  await run(true);
  statuses.push(passedLint);
  await run(true);
  assert.equal(events.some((event) => event[0] === 'close'), false);
});

test('requires the recorded publisher to recover from a subsequent status failure', async (t) => {
  const alerts = [{ ...alert, body: buildCIFailureIssue(repo, [checks[0]]).body }];
  const statuses = [{ ...passedLint, state: 'failure' }];
  const { run, events } = setup(t, { alerts, statuses, persistIssues: true });

  await run(true);
  assert.equal(alerts.length, 1);
  assert.equal(events.filter((event) => event[0] === 'update').length, 1);

  statuses[0] = { ...passedLint, creator: { login: 'other-bot', id: 43 } };
  await run(true);
  assert.equal(events.some((event) => event[0] === 'close'), false);

  statuses[0] = passedLint;
  await run(true);
  assert.equal(events.filter((event) => event[0] === 'close').length, 1);
});

for (const partial of [true, false]) {
  test(`requires manual closure after a subsequent ${partial ? 'incomplete scan' : 'unidentified failure'}`, async (t) => {
    const alerts = [{ ...alert, title: `[CI Failure] ${repo}` }];
    const runs = [{ ...passedBuild, conclusion: 'failure', check_suite: partial ? { id: 200 } : null }];
    const { run, events } = setup(t, {
      alerts, runs, persistIssues: true,
      checksError: partial ? new Error('Later check page unavailable') : undefined,
    });

    if (partial) await assert.rejects(run(true), /maintenance operations/);
    else await run(true);
    assert.match(alerts[0].body, /<!-- oss-issue-opener:ci:v1 owner\/project -->$/);

    alerts[0].title = 'Renamed CI alert';
    runs[0] = { ...passedBuild, conclusion: 'failure' };
    const recovered = setup(t, { alerts, persistIssues: true, runs });
    await recovered.run(true);
    runs[0] = passedBuild;
    await recovered.run(true);
    assert.equal(alerts.length, 1);
    assert.equal([...events, ...recovered.events].some((event) => event[0] === 'close'), false);
  });
}
