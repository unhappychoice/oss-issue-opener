import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getOctokit, initOctokit } from '../dist/github.js';
import { buildCIFailureIssue, buildPendingReleaseIssue, createIssuesInBatch } from '../dist/issue.js';

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

test('escapes Markdown-significant characters in changed filenames', () => {
  const malicious = 'src/x`](https://evil.example/malware)';
  const maliciousIssue = buildPendingReleaseIssue('owner/repo', [malicious], [], 'https://good.example/compare');

  assert.ok(maliciousIssue.body.includes('- `src/x\\`\\]\\(https://evil.example/malware\\)`'));
  assert.ok(!maliciousIssue.body.includes('`](https://evil.example/malware)'));
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
