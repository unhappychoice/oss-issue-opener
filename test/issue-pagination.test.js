import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getOctokit, initOctokit } from '../dist/github.js';
import { createIssuesInBatch } from '../dist/issue.js';

['ci-failure', 'pending-release'].forEach((label) => {
  test(`ignores ${label} pull requests and skips matching issues on every page`, async () => {
    initOctokit('test-token');
    const created = [];
    const pages = [];
    getOctokit().hook.wrap('request', async (_request, options) => {
      const endpoint = getOctokit().request.endpoint(options);
      const url = new URL(endpoint.url);
      if (endpoint.method === 'POST') {
        created.push({ ...endpoint.body });
        const data = { number: 32, labels: [{ name: label }] };
        return { status: 201, headers: {}, data, url: url.href };
      }

      assert.equal(url.pathname, '/repos/unhappychoice/oss-issue-opener/issues');
      assert.equal(url.searchParams.get('state'), 'open');
      assert.equal(url.searchParams.get('per_page'), '100');
      const currentLabel = url.searchParams.get('labels');
      const page = Number(url.searchParams.get('page') ?? 1);
      pages.push([currentLabel, page]);
      const data = page === 1
        ? [
            { title: 'Existing issue', number: 1 },
            { title: 'Later page title', number: 2, pull_request: {} },
            { title: 'PR-only title', number: 3, pull_request: {} },
          ]
        : [{ title: 'Later page title', number: 31 }];
      url.searchParams.set('page', '2');
      const headers = page === 1
        ? { link: `<${url.href}>; rel="next"` } : {};
      return { status: 200, headers, data, url: endpoint.url };
    });

    const titles = ['Existing issue', 'Later page title', 'PR-only title'];
    await createIssuesInBatch(titles.map((title) => ({
      type: label, repo: 'owner/repo', title, body: 'Issue body',
    })));

    assert.deepEqual(pages, [[label, 1], [label, 2]]);
    assert.deepEqual(created, [{ title: 'PR-only title', body: 'Issue body', labels: [label] }]);
  });
});

['ci-failure', 'pending-release'].forEach((label) => {
  test(`does not create issues when a later ${label} page fails`, async (t) => {
    initOctokit('test-token');
    const failure = new Error('Later page lookup failed');
    const pages = [];
    const create = t.mock.method(getOctokit().issues, 'create', async () => ({ data: { number: 32 } }));
    t.mock.method(console, 'error', () => {});
    t.after(() => t.mock.restoreAll());
    getOctokit().hook.wrap('request', async (_request, options) => {
      const endpoint = getOctokit().request.endpoint(options);
      const url = new URL(endpoint.url);
      const currentLabel = url.searchParams.get('labels');
      const page = Number(url.searchParams.get('page') ?? 1);
      pages.push([currentLabel, page]);
      if (page === 2) throw failure;
      url.searchParams.set('page', '2');
      return {
        status: 200,
        headers: { link: `<${url.href}>; rel="next"` },
        data: [{ title: 'Existing title', number: 1 }],
        url: endpoint.url,
      };
    });

    await assert.rejects(createIssuesInBatch([
      { type: label, repo: 'owner/repo', title: 'New title', body: 'Issue body' },
    ]), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 1);
      assert.equal(error.errors[0].cause, failure);
      return true;
    });
    assert.deepEqual(pages, [[label, 1], [label, 2]]);
    assert.equal(create.mock.callCount(), 0);
  });
});
