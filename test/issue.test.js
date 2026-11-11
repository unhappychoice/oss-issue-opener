import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getOctokit, initOctokit } from '../dist/github.js';
import { buildCIFailureIssue, createIssuesInBatch } from '../dist/issue.js';

const setup = (t, create, existing = []) => {
  initOctokit('test-token');
  t.mock.method(getOctokit().issues, 'listForRepo', async () => ({ data: existing }));
  const attempts = t.mock.method(getOctokit().issues, 'create', create);
  const logs = t.mock.method(console, 'log', () => {});
  const errors = t.mock.method(console, 'error', () => {});
  t.after(() => t.mock.restoreAll());
  return { attempts, logs, errors };
};

const issue = (repo) => buildCIFailureIssue(repo, []);

test('continues after a failed creation and reports successes and failures', async (t) => {
  const cause = new Error('HTTP 503');
  const { attempts, logs, errors } = setup(t, async ({ title }) => {
    if (title === issue('a').title) throw cause;
    return { data: { number: 42 } };
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

test('aggregates all creation failures after attempting every issue', async (t) => {
  const { attempts } = setup(t, async () => { throw new Error('HTTP 503'); });
  await assert.rejects(createIssuesInBatch([issue('a'), issue('b')]), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    assert.match(error.message, /Failed to create 2 of 2 issues/);
    return true;
  });
  assert.equal(attempts.mock.callCount(), 2);
});

test('resolves when creation succeeds and skips existing issues', async (t) => {
  const { attempts, logs, errors } = setup(t, async () => ({ data: { number: 42 } }), [
    { title: issue('a').title, number: 1 },
  ]);
  await createIssuesInBatch([issue('a'), issue('b')]);
  assert.equal(attempts.mock.callCount(), 1);
  assert.equal(attempts.mock.calls[0].arguments[0].title, issue('b').title);
  assert.ok(logs.mock.calls.some(({ arguments: [message] }) => message.includes('[skip]')));
  assert.equal(errors.mock.callCount(), 0);
});
