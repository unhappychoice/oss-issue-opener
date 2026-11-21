import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { getDefaultBranchHead, initOctokit } from '../dist/github.js';

const entryPoint = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const sha = 'a'.repeat(40);

test('CLI reports a stalled CI page and submits findings from another repository before exiting', () => {
  const preload = `
    const deadlines = new WeakMap();
    AbortSignal.timeout = () => {
      const controller = new AbortController();
      deadlines.set(controller.signal, controller);
      return controller.signal;
    };

    globalThis.fetch = async (url, { method, signal }) => {
      const { origin, pathname, searchParams } = new URL(url);
      if (origin !== 'https://api.github.com') throw new Error('Unexpected origin: ' + origin);
      const json = (data, options) => {
        const response = Response.json(data, options);
        Object.defineProperty(response, 'url', { value: url });
        return response;
      };

      const stalledChecks = '/repos/unhappychoice/stalled/commits/${sha}/check-runs';
      if (pathname === stalledChecks && searchParams.get('page') === '2') {
        return new Response(new ReadableStream({
          start(stream) {
            stream.enqueue(new TextEncoder().encode('{"check_runs":['));
          },
          pull(stream) {
            deadlines.get(signal).abort(new DOMException('Deadline expired', 'TimeoutError'));
            stream.error(signal.reason);
          },
        }), { headers: { 'content-type': 'application/json' } });
      }

      if (pathname === stalledChecks) {
        const next = new URL(url);
        next.searchParams.set('page', '2');
        return json({ total_count: 101, check_runs: [] }, {
          headers: { link: '<' + next + '>; rel="next"' },
        });
      }
      if (pathname === '/users/unhappychoice/repos') {
        return Response.json(['stalled', 'completed'].map((repo) => ({
          full_name: 'unhappychoice/' + repo, default_branch: 'main',
        })));
      }
      if (pathname === '/repos/unhappychoice/oss-issue-opener/issues' && method === 'POST') {
        return Response.json({ number: 1, labels: ['ci-failure'] }, { status: 201 });
      }
      if (['/repos', '/releases', '/tags', '/issues'].some((suffix) => pathname.endsWith(suffix))) return Response.json([]);
      if (pathname.startsWith('/users/')) return Response.json({ type: 'User' });
      if (pathname.endsWith('/branches/main')) {
        return Response.json({ commit: { sha: '${sha}', commit: { tree: { sha: 'tree' } } } });
      }
      if (pathname.endsWith('/check-suites')) return Response.json({ total_count: 0, check_suites: [] });
      if (pathname.endsWith('/check-runs')) return json({ total_count: 0, check_runs: [] });
      if (pathname.endsWith('/status')) {
        return Response.json({ statuses: pathname.includes('/completed/') ? [{ state: 'failure', context: 'build' }] : [] });
      }
      throw new Error('Unexpected GitHub request: ' + method + ' ' + pathname);
    };
  `;
  const result = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, entryPoint], {
    env: { ...process.env, GH_TOKEN: 'test-token' },
    encoding: 'utf8',
    timeout: 5_000,
  });

  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /\[failed\] unhappychoice\/stalled: CI investigation.*TimeoutError/);
  assert.match(result.stderr, /Fatal error: AggregateError: Failed 1 maintenance operations/);
  assert.match(result.stdout, /\[created\] \[CI Failure\] unhappychoice\/completed/);
});

test('a deadline while resolving the default branch propagates to the investigation', async (t) => {
  const deadline = new AbortController();
  const timeout = t.mock.method(AbortSignal, 'timeout', () => deadline.signal);
  initOctokit('test-token', 20);
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) =>
    new Response(new ReadableStream({
      pull(stream) {
        deadline.abort(new DOMException('Deadline expired', 'TimeoutError'));
        stream.error(signal.reason);
      },
    }, { highWaterMark: 0 }), { status: 404, headers: { 'content-type': 'application/json' } }));

  await assert.rejects(getDefaultBranchHead('owner', 'repo'), { name: 'TimeoutError' });
  assert.deepEqual(timeout.mock.calls.map(({ arguments: args }) => args), [[20]]);
});
