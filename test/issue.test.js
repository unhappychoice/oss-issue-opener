import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getOctokit, initOctokit } from '../dist/github.js';
import { buildCIFailureIssue, buildPendingReleaseIssue, createIssuesInBatch } from '../dist/issue.js';
import { recoveryCheckKey } from '../dist/recovery-key.js';

const setup = (t, create, existing = []) => {
  initOctokit('test-token');
  t.mock.method(getOctokit(), 'paginate', async () => existing);
  const attempts = t.mock.method(getOctokit().issues, 'create', create);
  const logs = t.mock.method(console, 'log', () => {});
  const errors = t.mock.method(console, 'error', () => {});
  t.after(() => t.mock.restoreAll());
  return { attempts, logs, errors };
};

const issue = (repo) => buildCIFailureIssue(repo, []);

const setupAlertUpdate = (t, alert, author = 'bot') => {
  initOctokit('test-token');
  const client = getOctokit();
  const alerts = [{ ...alert, user: { login: author } }];
  t.mock.method(client, 'paginate', async () => alerts);
  t.mock.method(client.issues, 'get', async () => ({ data: alerts[0] }));
  t.mock.method(client.issues, 'update', async ({ body }) => { alerts[0].body = body; });
  t.mock.method(client.users, 'getAuthenticated', async () => ({ data: { login: author } }));
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  t.after(() => t.mock.restoreAll());
  return alerts;
};

const setupAlertsUpdate = (t, initialAlerts, authenticatedAs = 'bot') => {
  initOctokit('test-token');
  const client = getOctokit();
  const alerts = initialAlerts.map((alert) => ({ ...alert }));
  t.mock.method(client, 'paginate', async () => alerts);
  t.mock.method(client.issues, 'get', async ({ issue_number }) => ({ data: alerts.find(({ number }) => number === issue_number) }));
  const updates = [];
  t.mock.method(client.issues, 'update', async ({ issue_number, body }) => {
    updates.push(issue_number);
    alerts.find(({ number }) => number === issue_number).body = body;
  });
  t.mock.method(client.users, 'getAuthenticated', async () => ({ data: { login: authenticatedAs } }));
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  t.after(() => t.mock.restoreAll());
  return { alerts, updates };
};

test('escapes Markdown-significant check names and rejects non-http(s) URLs', () => {
  const maliciousIssue = buildCIFailureIssue('owner/repo', [
    { name: 'build](https://evil.example/phish)[', url: 'https://good.example/actions' },
    { name: '`rm -rf`', url: 'javascript:alert(1)' },
    { name: 'lint', url: 'https://good.example) [Click here](https://evil.example' },
  ]);

  assert.ok(maliciousIssue.body.includes('- [build\\]\\(https://evil.example/phish\\)\\[](https://good.example/actions)'));
  assert.ok(maliciousIssue.body.includes('- \\`rm -rf\\`'));
  assert.ok(!maliciousIssue.body.includes('[Click here](https://evil.example'));
});

test('rejects check URLs that smuggle a second Markdown link without using spaces', () => {
  const maliciousIssue = buildCIFailureIssue('owner/repo', [
    { name: 'build', url: 'https://good.example/)[ClickHere](https://evil.example/' },
  ]);

  assert.ok(!maliciousIssue.body.includes(']('), 'should not contain any Markdown link syntax');
  assert.ok(!maliciousIssue.body.includes('https://evil.example'));
  assert.ok(maliciousIssue.body.includes('- build'));
});

test('escapes Markdown-significant characters in changed filenames', () => {
  const malicious = 'src/x`](https://evil.example/malware)';
  const maliciousIssue = buildPendingReleaseIssue('owner/repo', [malicious], [], 'https://good.example/compare');

  assert.ok(maliciousIssue.body.includes('- `src/x\\`\\]\\(https://evil.example/malware\\)`'));
  assert.ok(!maliciousIssue.body.includes('`](https://evil.example/malware)'));
});

test('renders dependency names and ordinary versions in code spans', () => {
  const issue = buildPendingReleaseIssue('owner/repo', [], [
    { pkg: '@scope/example', from: '1.2.3', to: '2.0.0-beta.1+build' },
    { pkg: 'name``with[brackets]', from: '1.0.0', to: '1.0.1' },
  ], 'https://example.com/compare');

  assert.deepEqual(issue.body.split('\n').slice(3, 5), [
    '- ` @scope/example ` ` 1.2.3 ` -> ` 2.0.0-beta.1+build `',
    '- ``` name``with[brackets] ``` ` 1.0.0 ` -> ` 1.0.1 `',
  ]);
});

test('lists up to five changed source files and reports the remaining count', () => {
  const sources = Array.from({ length: 7 }, (_, index) => `src/file-${index + 1}.ts`);
  const visibleFiles = sources.slice(0, 5).map((path) => `- \`${path}\``);

  const sourceSection = (paths) => {
    const { body } = buildPendingReleaseIssue('owner/repo', paths, [], 'https://good.example/compare');
    return body.split('\n\n').find((section) => section.startsWith('**Source code changes:**'));
  };

  const expected = ['**Source code changes:**', ...visibleFiles].join('\n');
  assert.equal(sourceSection(sources.slice(0, 5)), expected);
  assert.equal(sourceSection(sources), `${expected}\n- ... and 2 more files`);
});

test('limits failed checks to whole list items and preserves notification links', () => {
  const checks = Array.from({ length: 1_000 }, (_, index) => ({
    name: `build-${index}`,
    url: `https://example.com/checks/${index}/${'a'.repeat(50)}`,
  }));
  const { body } = buildCIFailureIssue('owner/repo', checks);
  const [, section, links] = body.split('\n\n');
  const [, ...items] = section.split('\n');
  const summary = items.pop();

  assert.ok(body.length <= 65_536);
  assert.ok(items.length > 0 && items.length < checks.length);
  assert.deepEqual(items, checks.slice(0, items.length).map(({ name, url }) => `- [${name}](${url})`));
  assert.equal(summary, `- ... and ${checks.length - items.length} more`);
  assert.equal(links, '**Repository**: https://github.com/owner/repo\n**Actions**: https://github.com/owner/repo/actions');
});

test('keeps a check at the body limit and omits it whole when it exceeds the limit', () => {
  const repo = 'owner/repo';
  const emptyBody = buildCIFailureIssue(repo, []).body;
  const name = 'a'.repeat(65_536 - emptyBody.length - '- '.length);
  const exact = buildCIFailureIssue(repo, [{ name }]).body;
  const oversized = buildCIFailureIssue(repo, [{ name: `${name}a` }]).body;

  assert.equal(exact.length, 65_536);
  assert.equal(exact, emptyBody.replace('**Failed checks:**\n', `**Failed checks:**\n- ${name}`));
  assert.equal(oversized, emptyBody.replace('**Failed checks:**\n', '**Failed checks:**\n- ... and 1 more'));
});

test('limits dependency updates while preserving confirmed source changes and links', () => {
  const updates = Array.from({ length: 1_000 }, (_, index) => ({
    pkg: `@example/runtime-dependency-${index}`,
    from: '1.2.3-alpha.1234567',
    to: '1.2.3-alpha.1234568',
  }));
  const compareUrl = 'https://github.com/owner/repo/compare/v1.2.3...main';
  const { body } = buildPendingReleaseIssue('owner/repo', ['src/index.ts'], updates, compareUrl);
  const [, sources, section, links] = body.split('\n\n');
  const [, ...items] = section.split('\n');
  const summary = items.pop();

  assert.ok(body.length <= 65_536);
  assert.equal(sources, '**Source code changes:**\n- `src/index.ts`');
  assert.ok(items.length > 0 && items.length < updates.length);
  assert.deepEqual(items, updates.slice(0, items.length).map(({ pkg, from, to }) =>
    `- \` ${pkg} \` \` ${from} \` -> \` ${to} \``));
  assert.equal(summary, `- ... and ${updates.length - items.length} more`);
  assert.equal(links, `**Diff**: ${compareUrl}\n**Releases**: https://github.com/owner/repo/releases`);
});

test('continues after a failed creation and reports successes and failures', async (t) => {
  const cause = new Error('HTTP 503');
  const { attempts, logs, errors } = setup(t, async ({ title }) => {
    if (title === issue('a').title) throw cause;
    return { data: { number: 42, labels: [{ name: 'ci-failure' }] } };
  });

  await assert.rejects(createIssuesInBatch([issue('b'), issue('a')]), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 1);
    assert.equal(error.errors[0].cause, cause);
    assert.match(error.errors[0].message, /\[CI Failure\] a/);
    return true;
  });
  assert.deepEqual(attempts.mock.calls.map(({ arguments: [input] }) => input.title), [issue('a').title, issue('b').title]);
  assert.ok(logs.mock.calls.some(({ arguments: [message] }) => message.includes('[created] [CI Failure] b (#42)')));
  assert.equal(errors.mock.calls[0].arguments[0], '  [failed] [CI Failure] a');
});

test('reports the issue number when a successful create response lacks the expected label', async (t) => {
  const { attempts, logs, errors } = setup(t, async ({ title }) => title === issue('a').title
    ? { status: 201, data: { number: 41, labels: [] } }
    : { status: 201, data: { number: 42, labels: [{ name: 'ci-failure' }] } });

  await assert.rejects(createIssuesInBatch([issue('a'), issue('b')]), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 1);
    assert.match(error.errors[0].message, /\[CI Failure\] a/);
    assert.match(error.errors[0].cause.message, /#41.*ci-failure/);
    return true;
  });
  assert.equal(attempts.mock.callCount(), 2);
  assert.deepEqual(logs.mock.calls.map(({ arguments: [message] }) => message)
    .filter((message) => message.includes('[created]')), ['  [created] [CI Failure] b (#42)']);
  assert.equal(errors.mock.callCount(), 1);
  const [message, cause] = errors.mock.calls[0].arguments;
  assert.equal(message, '  [failed] [CI Failure] a');
  assert.match(cause.message, /#41.*ci-failure/);
});

test('aggregates all creation failures after attempting every issue', async (t) => {
  const { attempts } = setup(t, async () => { throw new Error('HTTP 503'); });
  await assert.rejects(createIssuesInBatch([issue('a'), issue('b')]), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    assert.match(error.message, /Issue batch failed with 2 errors/);
    return true;
  });
  assert.equal(attempts.mock.callCount(), 2);
});

test('omits every recovery identity, not just the unidentifiable one, when a failed check has no identity', () => {
  const repo = 'owner/repo';
  const identifiedCheck = { name: 'build', source: 'check', workflowId: 1, url: '' };
  const unidentifiedCheck = { name: 'unknown', source: 'check', url: '' };

  const { body } = buildCIFailureIssue(repo, [identifiedCheck, unidentifiedCheck]);

  assert.ok(body.endsWith(`<!-- oss-issue-opener:ci:v1 ${repo} -->`));
});

test('retains both recovered checks when a near-limit alert gains an identifiable failure', async (t) => {
  const repo = 'owner/repo';

  const firstCheck = { name: 'x', source: 'check', workflowId: 1, url: 'https://e/' };
  const secondCheck = { name: 'y', source: 'status', publisherId: 2, url: '' };
  const key1 = recoveryCheckKey(firstCheck);
  const key2 = recoveryCheckKey(secondCheck);

  // Pad the check's URL (not part of its recovery identity) so the alert body fills the
  // 65,536-char issue limit while its recovery marker stays far below half that limit.
  const baseline = buildCIFailureIssue(repo, [firstCheck]).body;
  const extra = 65_536 - baseline.length;
  const paddedCheck = { ...firstCheck, url: firstCheck.url + 'a'.repeat(extra) };
  const initial = buildCIFailureIssue(repo, [paddedCheck]);
  assert.equal(initial.body.length, 65_536);

  const originalMarker = initial.body.match(/\n\n<!-- oss-issue-opener:ci:v1 ([^\n]*) -->$/);
  assert.equal(originalMarker[1], `${repo} ${key1}`);
  assert.ok(originalMarker[0].length < 65_536 / 2);

  const alerts = setupAlertUpdate(t, {
    number: 1, title: initial.title, body: initial.body, labels: [{ name: 'ci-failure' }], state: 'open',
  });

  const nextIssue = buildCIFailureIssue(repo, [secondCheck]);
  await createIssuesInBatch([nextIssue]);

  assert.ok(alerts[0].body.length <= 65_536);
  assert.match(alerts[0].body, /- \.\.\. and 1 more/);
  const updatedMarker = alerts[0].body.match(/\n\n<!-- oss-issue-opener:ci:v1 ([^\n]*) -->$/);
  const [updatedRepo, ...keys] = updatedMarker[1].split(' ');
  assert.equal(updatedRepo, repo);
  assert.deepEqual(new Set(keys), new Set([key1, key2]));
});

test('preserves an edited body at the issue limit and removes its recovery identities', async (t) => {
  const repo = 'owner/repo';
  const firstCheck = { name: 'build', source: 'check', workflowId: 1 };
  const nextCheck = { name: 'lint', source: 'check', workflowId: 2 };
  const initial = buildCIFailureIssue(repo, [firstCheck]);
  const edited = initial.body.replace('**Actions**', '**Workflow history**') + '\n';
  const notes = 'a'.repeat(65_536 - edited.length - 2) + '\n\n';
  const alerts = setupAlertUpdate(t, {
    number: 1, title: initial.title, body: notes + edited, labels: [{ name: 'ci-failure' }], state: 'open',
  });
  assert.equal(alerts[0].body.length, 65_536);

  await createIssuesInBatch([buildCIFailureIssue(repo, [nextCheck])]);

  assert.equal(alerts[0].body, notes + edited.replace(` ${recoveryCheckKey(firstCheck)} -->`, ' -->'));
});

test('falls back to a bare marker and requires manual closure when the merged checks exceed the recovery budget', async (t) => {
  const repo = 'owner/repo';

  // Each identity fits the recovery metadata budget on its own, but their union does not.
  const recordedCheck = { name: 'a'.repeat(20_000), source: 'check', workflowId: 1, url: '' };
  const incomingCheck = { name: 'b'.repeat(20_000), source: 'check', workflowId: 2, url: '' };

  const initial = buildCIFailureIssue(repo, [recordedCheck]);
  const originalMarker = initial.body.match(/\n\n<!-- oss-issue-opener:ci:v1 ([^\n]*) -->$/);
  assert.ok(originalMarker[0].length < 65_536 / 2);

  const alerts = setupAlertUpdate(t, {
    number: 1, title: initial.title, body: initial.body, labels: [{ name: 'ci-failure' }], state: 'open',
  });

  const nextIssue = buildCIFailureIssue(repo, [incomingCheck]);
  const incomingMarker = nextIssue.body.match(/\n\n<!-- oss-issue-opener:ci:v1 ([^\n]*) -->$/);
  assert.ok(incomingMarker[0].length < 65_536 / 2);

  await createIssuesInBatch([nextIssue]);

  assert.ok(alerts[0].body.length <= 65_536);
  assert.match(alerts[0].body, /<!-- oss-issue-opener:ci:v1 owner\/repo -->$/);
});

test('extends an already-truncated check list further when more recovery metadata space is needed', async (t) => {
  const repo = 'owner/repo';

  const key1 = recoveryCheckKey({ name: 'c0', source: 'check', workflowId: 1 });
  const key2 = recoveryCheckKey({ name: 'c1', source: 'check', workflowId: 2 });
  const key3 = recoveryCheckKey({ name: 'c2', source: 'check', workflowId: 3 });
  const links = `\n\n**Repository**: https://github.com/${repo}\n**Actions**: https://github.com/${repo}/actions`;
  const intro = 'CI is failing on the default branch.\n\n**Failed checks:**\n';
  const marker2 = `\n\n<!-- oss-issue-opener:ci:v1 ${repo} ${key1} ${key2} -->`;
  const existingSummary = '- ... and 1 more';

  // Pad a check list that is already truncated (one check hidden behind a summary line) so the
  // alert body fills the issue limit, then force a second reclaim when a third check is merged.
  const fixedLength = intro.length + 1 + existingSummary.length + links.length + marker2.length;
  const bigBulletLine = `- ${'a'.repeat(65_536 - fixedLength - 2)}`;
  const visibleInput = `${intro}${bigBulletLine}\n${existingSummary}`;
  const initialBody = `${visibleInput}${links}${marker2}`;
  assert.equal(initialBody.length, 65_536);

  const alerts = setupAlertUpdate(t, {
    number: 1, title: `[CI Failure] ${repo}`, body: initialBody, labels: [{ name: 'ci-failure' }], state: 'open',
  });

  const nextIssue = buildCIFailureIssue(repo, [{ name: 'c2', source: 'check', workflowId: 3, url: '' }]);
  await createIssuesInBatch([nextIssue]);

  assert.ok(alerts[0].body.length <= 65_536);
  assert.match(alerts[0].body, /- \.\.\. and 2 more/);
  const updatedMarker = alerts[0].body.match(/\n\n<!-- oss-issue-opener:ci:v1 ([^\n]*) -->$/);
  const [updatedRepo, ...keys] = updatedMarker[1].split(' ');
  assert.equal(updatedRepo, repo);
  assert.deepEqual(new Set(keys), new Set([key1, key2, key3]));
});

test('updates only the recovery candidate for the notification repository, leaving other repos untouched', async (t) => {
  const repoA = 'owner/a';
  const repoB = 'owner/b';
  const alertA = buildCIFailureIssue(repoA, [{ name: 'build', source: 'check', workflowId: 1, url: '' }]);
  const alertB = buildCIFailureIssue(repoB, [{ name: 'lint', source: 'status', publisherId: 2, url: '' }]);

  const { alerts, updates } = setupAlertsUpdate(t, [
    { number: 1, title: alertA.title, body: alertA.body, labels: [{ name: 'ci-failure' }], state: 'open', user: { login: 'bot' } },
    { number: 2, title: alertB.title, body: alertB.body, labels: [{ name: 'ci-failure' }], state: 'open', user: { login: 'bot' } },
  ]);

  const nextIssue = buildCIFailureIssue(repoB, [{ name: 'typecheck', source: 'check', workflowId: 3, url: '' }]);
  await createIssuesInBatch([nextIssue]);

  assert.deepEqual(updates, [2]);
  assert.equal(alerts[0].body, alertA.body);
  assert.notEqual(alerts[1].body, alertB.body);
});

test('matches a renamed alert through its recovery marker when the title no longer matches', async (t) => {
  const repo = 'owner/repo';
  const initial = buildCIFailureIssue(repo, [{ name: 'build', source: 'check', workflowId: 1, url: '' }]);

  const { alerts, updates } = setupAlertsUpdate(t, [
    { number: 1, title: 'Investigate flaky build', body: initial.body, labels: [{ name: 'ci-failure' }], state: 'open', user: { login: 'bot' } },
  ]);

  const nextIssue = buildCIFailureIssue(repo, [{ name: 'lint', source: 'status', publisherId: 2, url: '' }]);
  await createIssuesInBatch([nextIssue]);

  assert.deepEqual(updates, [1]);
  assert.notEqual(alerts[0].body, initial.body);
});

test('creates a new alert when the matching recovery candidate was authored by someone else', async (t) => {
  const repo = 'owner/repo';
  const initial = buildCIFailureIssue(repo, [{ name: 'build', source: 'check', workflowId: 1, url: '' }]);

  const { updates } = setupAlertsUpdate(t, [
    { number: 1, title: 'Investigate flaky build', body: initial.body, labels: [{ name: 'ci-failure' }], state: 'open', user: { login: 'someone-else' } },
  ]);
  const create = t.mock.method(getOctokit().issues, 'create', async () => ({ data: { number: 2, labels: [{ name: 'ci-failure' }] } }));

  const nextIssue = buildCIFailureIssue(repo, [{ name: 'lint', source: 'status', publisherId: 2, url: '' }]);
  await createIssuesInBatch([nextIssue]);

  assert.deepEqual(updates, []);
  assert.equal(create.mock.callCount(), 1);
});

test('resolves when creation succeeds and skips existing issues', async (t) => {
  const { attempts, logs, errors } = setup(t, async () => ({ data: { number: 42, labels: ['ci-failure'] } }), [
    { title: issue('a').title, number: 1 },
  ]);
  await createIssuesInBatch([issue('a'), issue('b')]);
  assert.equal(attempts.mock.callCount(), 1);
  assert.equal(attempts.mock.calls[0].arguments[0].title, issue('b').title);
  assert.ok(logs.mock.calls.some(({ arguments: [message] }) => message.includes('[skip]')));
  assert.equal(errors.mock.callCount(), 0);
});

test('skips a duplicate after creating its title and type in the same batch', async (t) => {
  const notification = issue('owner/repo');
  const { attempts, logs } = setup(t, async ({ labels }) => ({ data: { number: 42, labels } }));
  await createIssuesInBatch([notification, notification, { ...notification, type: 'pending-release' }]);

  assert.deepEqual(attempts.mock.calls.map(({ arguments: [input] }) => input.labels), [
    ['ci-failure'],
    ['pending-release'],
  ]);
  assert.deepEqual(logs.mock.calls.map(({ arguments: [message] }) => message)
    .filter((message) => message.includes('[skip]')), [`  [skip] ${notification.title} (already exists)`]);
});

test('retries a duplicate after a failed creation and skips it after success', async (t) => {
  const notification = issue('owner/repo');
  const cause = new Error('HTTP 503');
  const { attempts, logs } = setup(t, async ({ labels }) => ({ data: { number: 42, labels } }));
  attempts.mock.mockImplementationOnce(async () => { throw cause; });

  await assert.rejects(createIssuesInBatch([notification, notification, notification]), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors.map((failure) => failure.cause), [cause]);
    return true;
  });
  assert.equal(attempts.mock.callCount(), 2);
  assert.equal(logs.mock.calls.filter(({ arguments: [message] }) => message.includes('[skip]')).length, 1);
});

test('a subsequent batch skips notifications created by the preceding batch', async (t) => {
  const existing = [];
  const { attempts, logs } = setup(t, async ({ title, labels }) => {
    existing.push({ title, labels, number: existing.length + 1 });
    return { data: { number: existing.length, labels: labels.map((name) => ({ name })) } };
  });
  const lookup = t.mock.method(getOctokit(), 'paginate', async (_method, { labels }) =>
    existing.filter((entry) => entry.labels.includes(labels)));
  const notifications = [issue('owner/repo'), {
    type: 'pending-release', repo: 'owner/repo', title: '[Pending Release] owner/repo', body: 'Release pending',
  }];

  await createIssuesInBatch(notifications);
  await createIssuesInBatch(notifications);

  assert.equal(lookup.mock.callCount(), 4);
  assert.equal(attempts.mock.callCount(), 2);
  assert.equal(logs.mock.calls.filter(({ arguments: [message] }) => message.includes('[skip]')).length, 2);
});
