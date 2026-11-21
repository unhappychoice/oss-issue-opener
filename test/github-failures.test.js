import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { checkCIStatus, checkPendingRelease } from '../dist/checker.js';
import {
  getCheckRuns, getCommitStatus, getDefaultBranch, getLatestRelease,
  getOctokit, listOpenIssues,
} from '../dist/github.js';
import { buildCIFailureIssue, buildPendingReleaseIssue, createIssuesInBatch } from '../dist/issue.js';
import { initMockOctokit } from './helpers/github.mjs';

beforeEach(() => {
  initMockOctokit('test-token');
  mock.method(getOctokit().checks, 'listSuitesForRef', async () => ({ data: { total_count: 0 } }));
  mock.method(console, 'log', () => {});
  mock.method(console, 'error', () => {});
});
afterEach(() => mock.restoreAll());

const pendingIssue = () => buildCIFailureIssue('owner/repo', []);

[
  ['commit statuses', 'getCombinedStatusForRef', () => Array.fromAsync(getCommitStatus('owner', 'repo', 'main'))],
  ['releases', 'listReleases', () => getLatestRelease('owner', 'repo')],
  ['fallback tags', 'listTags', () => getLatestRelease('owner', 'repo')],
].forEach(([name, method, read]) => {
  test(`preserves the request error when ${name} retrieval fails`, async () => {
    const failure = new Error('HTTP 503');
    if (method === 'listTags') {
      mock.method(getOctokit().repos, 'listReleases', async () => ({ data: [] }));
    }
    const request = mock.method(getOctokit().repos, method, async () => {
      throw failure;
    });

    await assert.rejects(read(), (error) => error === failure);
    assert.equal(request.mock.callCount(), 1);
    assert.equal(request.mock.calls[0].arguments[0].owner, 'owner');
    assert.equal(request.mock.calls[0].arguments[0].repo, 'repo');
  });
});

test('returns null when default branch retrieval fails', async () => {
  mock.method(getOctokit().repos, 'get', async () => { throw new Error('HTTP 503'); });

  assert.equal(await getDefaultBranch('owner', 'repo'), null);
});

test('preserves the request error when check runs retrieval fails', async () => {
  const failure = new Error('HTTP 503');
  const request = mock.method(getOctokit().paginate, 'iterator', () => {
    throw failure;
  });

  await assert.rejects(Array.fromAsync(getCheckRuns('owner', 'repo', 'main')), (error) => error === failure);
  assert.equal(request.mock.callCount(), 1);
  assert.deepEqual(request.mock.calls[0].arguments, [
    getOctokit().checks.listForRef, { owner: 'owner', repo: 'repo', ref: 'main', per_page: 100 },
  ]);
});

test('reports no-ci and no-tag after successful empty reads', async () => {
  const client = getOctokit();
  mock.method(client.repos, 'getBranch', async () => ({ data: { commit: { sha: 'a'.repeat(40), commit: { tree: { sha: 'head-tree' } } } } }));
  mock.method(client.repos, 'get', async () => ({ data: { default_branch: 'main' } }));
  mock.method(client.repos, 'getCombinedStatusForRef', async () => ({ data: { statuses: [] } }));
  mock.method(client.paginate, 'iterator', async function* () { yield { data: [] }; });
  mock.method(client.repos, 'listReleases', async () => ({ data: [] }));
  mock.method(client.repos, 'listTags', async () => ({ data: [] }));

  assert.deepEqual(await checkCIStatus('owner', 'repo'), {
    status: 'no-ci', failedChecks: [],
  });
  assert.deepEqual(await checkPendingRelease('owner', 'repo', 'node'), { status: 'no-tag' });
});

const mockRelease = () => {
  mock.method(getOctokit().repos, 'listReleases', async () => ({ data: [{ tag_name: 'v1' }] }));
  mock.method(getOctokit().repos, 'get', async () => ({ data: { default_branch: 'main' } }));
};

['ci-failure', 'pending-release'].forEach((failedLabel) => {
  test(`continues the mixed batch when the ${failedLabel} lookup fails`, async () => {
    const failure = new Error('Issue lookup failed');
    mock.method(getOctokit(), 'paginate', async (_route, { labels }) => {
      if (labels === failedLabel) throw failure;
      return [];
    });
    const create = mock.method(getOctokit().issues, 'create', async (input) => ({
      data: { number: 1, labels: input.labels },
    }));
    const release = buildPendingReleaseIssue('owner/repo', ['src/index.ts'], [], 'https://example.com/compare');

    await assert.rejects(createIssuesInBatch([pendingIssue(), release]), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 1);
      assert.match(error.errors[0].message, new RegExp(failedLabel));
      assert.equal(error.errors[0].cause, failure);
      return true;
    });
    const eligibleIssue = failedLabel === 'ci-failure' ? release : pendingIssue();
    assert.deepEqual(create.mock.calls.map(({ arguments: [input] }) => input.title), [eligibleIssue.title]);
  });
});

test('reports lookup and creation failures in the same batch', async () => {
  const lookupFailure = new Error('Issue lookup failed');
  const creationFailure = new Error('Issue creation failed');
  mock.method(getOctokit(), 'paginate', async (_route, { labels }) => {
    if (labels === 'pending-release') throw lookupFailure;
    return [];
  });
  mock.method(getOctokit().issues, 'create', async () => { throw creationFailure; });
  const release = buildPendingReleaseIssue('owner/repo', ['src/index.ts'], [], 'https://example.com/compare');

  await assert.rejects(createIssuesInBatch([pendingIssue(), release]), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors.map(({ cause }) => cause), [lookupFailure, creationFailure]);
    return true;
  });
});

test('creates a CI issue without looking up pending release issues', async () => {
  const lookup = mock.method(getOctokit(), 'paginate', async (_route, { labels }) => {
    assert.equal(labels, 'ci-failure');
    return [];
  });
  const create = mock.method(getOctokit().issues, 'create', async () => ({
    data: { number: 1, labels: [{ name: 'ci-failure' }] },
  }));

  await createIssuesInBatch([pendingIssue()]);

  assert.equal(lookup.mock.callCount(), 1);
  assert.equal(create.mock.callCount(), 1);
  assert.equal(create.mock.calls[0].arguments[0].title, pendingIssue().title);
});

test('skips an existing issue with the same title', async () => {
  mock.method(getOctokit(), 'paginate', async () => [
    { title: pendingIssue().title, number: 1 },
  ]);
  const create = mock.method(getOctokit().issues, 'create', async () => ({ data: { number: 2 } }));

  await createIssuesInBatch([pendingIssue()]);

  assert.equal(create.mock.callCount(), 0);
});

test('returns a successful empty issue list', async () => {
  mock.method(getOctokit(), 'paginate', async () => []);

  assert.deepEqual(await listOpenIssues('owner', 'repo', 'ci-failure'), []);
});

test('rejects the release check when comparison fails instead of returning up-to-date', async () => {
  mockRelease();
  const failure = new Error('Comparison failed');
  mock.method(getOctokit().repos, 'compareCommits', async () => { throw failure; });

  await assert.rejects(checkPendingRelease('owner', 'repo', 'node'), (error) => error === failure);
});

test('returns up-to-date for a successful empty comparison', async () => {
  mockRelease();
  mock.method(getOctokit().repos, 'compareCommits', async () => ({ data: { files: [], commits: [] } }));

  assert.deepEqual(await checkPendingRelease('owner', 'repo', 'node'), { status: 'up-to-date' });
});
