import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { getDefaultBranchHead, initOctokit } from '../dist/github.js';

const entryPoint = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const sha = 'a'.repeat(40);

test('CLI reports a stalled CI page and submits findings from another repository before exiting', async (t) => {
  let stalledResponse;
  const server = createServer((request, response) => {
    const { pathname, searchParams } = new URL(request.url, 'https://api.github.com');
    if (pathname === `/repos/unhappychoice/stalled/commits/${sha}/check-runs` && searchParams.has('page')) {
      stalledResponse = response;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"check_runs":[');
      return;
    }

    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(githubResponse(request, response, pathname)));
  });
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const preload = `
    const fetch = globalThis.fetch;
    globalThis.fetch = (url, options) => {
      const { pathname, search } = new URL(url);
      return fetch('http://127.0.0.1:${server.address().port}' + pathname + search, options);
    };
    const timeout = AbortSignal.timeout;
    AbortSignal.timeout = () => timeout(500);
  `;
  await assert.rejects(
    promisify(execFile)(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, entryPoint], {
      env: { ...process.env, GH_TOKEN: 'test-token' },
      timeout: 5_000,
    }),
    ({ code, stdout, stderr }) => {
      assert.equal(code, 1, stderr);
      assert.match(stderr, /\[failed\] unhappychoice\/stalled: CI investigation.*TimeoutError/);
      assert.match(stderr, /Fatal error: AggregateError: Failed 1 investigation or creation operations/);
      assert.match(stdout, /\[created\] \[CI Failure\] unhappychoice\/completed/);
      assert.equal(stalledResponse?.destroyed, true);
      return true;
    },
  );
});

const githubResponse = (request, response, pathname) => {
  if (pathname === '/users/unhappychoice/repos') {
    return ['stalled', 'completed'].map((repo) => ({ full_name: `unhappychoice/${repo}`, default_branch: 'main' }));
  }
  if (pathname.endsWith('/issues') && request.method === 'POST') {
    response.statusCode = 201;
    return { number: 1, labels: ['ci-failure'] };
  }
  if (['/repos', '/releases', '/tags', '/issues'].some((suffix) => pathname.endsWith(suffix))) return [];
  if (pathname.startsWith('/users/')) return { type: 'User' };
  if (pathname.endsWith('/branches/main')) return { commit: { sha, commit: { tree: { sha: 'tree' } } } };
  if (pathname.endsWith('/check-suites')) return { total_count: 0, check_suites: [] };
  if (pathname.endsWith('/check-runs')) {
    if (pathname.includes('/stalled/')) {
      response.setHeader('link', `<https://api.github.com${pathname}?page=2>; rel="next"`);
    }
    return { total_count: 0, check_runs: [] };
  }
  if (pathname.endsWith('/status')) {
    return { statuses: pathname.includes('/completed/') ? [{ state: 'failure', context: 'build' }] : [] };
  }
  response.statusCode = 500;
  return { message: `Unexpected GitHub request: ${request.method} ${pathname}` };
};

test('a deadline while resolving the default branch propagates to the investigation', async (t) => {
  initOctokit('test-token', 20);
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => {
    const abort = new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    return new Response(new ReadableStream({
      async pull(controller) {
        await abort;
        controller.error(signal.reason);
      },
    }), { status: 404, headers: { 'content-type': 'application/json' } });
  });
  const keepAlive = setTimeout(() => {}, 1_000);
  t.after(() => clearTimeout(keepAlive));
  await assert.rejects(getDefaultBranchHead('owner', 'repo'), { name: 'TimeoutError' });
});
