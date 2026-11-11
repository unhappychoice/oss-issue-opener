import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { checkPendingRelease } from '../dist/checker.js';
import { getOctokit, initOctokit, listOpenIssues } from '../dist/github.js';
import { buildCIFailureIssue, createIssuesInBatch } from '../dist/issue.js';

beforeEach(() => {
  initOctokit('test-token');
  mock.method(console, 'log', () => {});
});
afterEach(() => mock.restoreAll());

const pendingIssue = () => buildCIFailureIssue('owner/repo', []);

const mockRelease = () => {
  mock.method(getOctokit().repos, 'listReleases', async () => ({ data: [{ tag_name: 'v1' }] }));
  mock.method(getOctokit().repos, 'get', async () => ({ data: { default_branch: 'main' } }));
};

['ci-failure', 'pending-release'].forEach((failedLabel) => {
  test(`does not create issues when ${failedLabel} lookup fails`, async () => {
    const failure = new Error('Issue lookup failed');
    mock.method(getOctokit(), 'paginate', async (_route, { labels }) => {
      if (labels === failedLabel) throw failure;
      return [];
    });
    const create = mock.method(getOctokit().issues, 'create', async () => ({ data: { number: 1 } }));

    await assert.rejects(createIssuesInBatch([pendingIssue()]), (error) => error === failure);
    assert.equal(create.mock.callCount(), 0);
  });
});

test('creates an issue when existing issue lists are successfully empty', async () => {
  mock.method(getOctokit(), 'paginate', async () => []);
  const create = mock.method(getOctokit().issues, 'create', async () => ({ data: { number: 1 } }));

  await createIssuesInBatch([pendingIssue()]);

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
