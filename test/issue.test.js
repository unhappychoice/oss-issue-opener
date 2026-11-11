import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getOctokit, initOctokit } from '../dist/github.js';
import { createIssuesInBatch } from '../dist/issue.js';

['ci-failure', 'pending-release'].forEach((label) => {
  test(`skips existing ${label} titles on every page and creates only new titles`, async () => {
    initOctokit('test-token');
    const created = [];
    const pages = [];
    getOctokit().hook.wrap('request', async (_request, options) => {
      const endpoint = getOctokit().request.endpoint(options);
      const url = new URL(endpoint.url);
      if (endpoint.method === 'POST') {
        created.push({ ...endpoint.body });
        return { status: 201, headers: {}, data: { number: 32 }, url: url.href };
      }

      assert.equal(url.pathname, '/repos/unhappychoice/oss-issue-opener/issues');
      assert.equal(url.searchParams.get('state'), 'open');
      const currentLabel = url.searchParams.get('labels');
      const page = Number(url.searchParams.get('page') ?? 1);
      pages.push([currentLabel, page]);
      const data = currentLabel !== label ? [] : page === 1
        ? Array.from({ length: 30 }, (_, index) => ({ title: `Existing ${index}`, number: index + 1 }))
        : [{ title: 'Later page title', number: 31 }];
      url.searchParams.set('page', '2');
      const headers = currentLabel === label && page === 1
        ? { link: `<${url.href}>; rel="next"` } : {};
      return { status: 200, headers, data, url: endpoint.url };
    });

    const titles = ['Existing 0', 'Later page title', 'New title'];
    await createIssuesInBatch(titles.map((title) => ({
      type: label, repo: 'owner/repo', title, body: 'Issue body',
    })));

    assert.deepEqual(pages, label === 'ci-failure'
      ? [['ci-failure', 1], ['ci-failure', 2], ['pending-release', 1]]
      : [['ci-failure', 1], ['pending-release', 1], ['pending-release', 2]]);
    assert.deepEqual(created, [{ title: 'New title', body: 'Issue body', labels: [label] }]);
  });
});
