import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const entryPoint = fileURLToPath(new URL('../dist/index.js', import.meta.url));

test('CLI exits with an error when GH_TOKEN is missing', () => {
  const env = { ...process.env };
  delete env.GH_TOKEN;
  const result = spawnSync(process.execPath, [entryPoint], {
    env, encoding: 'utf8',
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '❌ Error: GH_TOKEN is not set\n');
});

const runAuthenticatedCLI = (failLookup) => {
  const preload = `
    globalThis.fetch = async (url, options) => {
      const { origin, pathname } = new URL(url);
      if (origin !== 'https://api.github.com' || options.method !== 'GET' ||
          new Headers(options.headers).get('authorization') !== 'token test-token') {
        throw new Error('Unexpected GitHub request: ' + url);
      }
      if (${failLookup} && pathname === '/users/unhappychoice') {
        return Response.json({ message: 'Repository lookup denied' }, { status: 403 });
      }
      if (/^\\/users\\/[^/]+$/.test(pathname)) return Response.json({ type: 'User' });
      if (/^\\/users\\/[^/]+\\/repos$/.test(pathname)) return Response.json([]);
      throw new Error('Unexpected GitHub endpoint: ' + url);
    };
  `;
  return spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, entryPoint], {
    env: { ...process.env, GH_TOKEN: 'test-token' }, encoding: 'utf8',
  });
};

test('CLI authenticates and reports a successful scan of empty accounts', () => {
  const result = runAuthenticatedCLI(false);

  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /GitHub authentication initialized/);
  assert.match(result.stdout, /Total repositories: 0/);
});

test('CLI reports a failed account lookup and exits with status 1', () => {
  const result = runAuthenticatedCLI(true);

  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\[failed\] unhappychoice: repository investigation/);
  assert.match(result.stderr, /Repository lookup denied/);
  assert.match(result.stderr, /Fatal error: AggregateError: Failed 1 maintenance operations/);
});

const runCLIWithCIFailures = (endpoint, hasFailure) => {
  const failListing = endpoint === 'listing';
  const sha = 'a'.repeat(40);
  const preload = `
    const endpoint = ${JSON.stringify(endpoint)};
    globalThis.fetch = async (url, options) => {
      const { origin, pathname, searchParams } = new URL(url);
      const respond = (data, init) => {
        const response = Response.json(data, init);
        Object.defineProperty(response, 'url', { value: url });
        return response;
      };
      if (origin !== 'https://api.github.com') throw new Error('Unexpected origin: ' + origin);
      if (options.method === 'POST' && pathname === '/repos/unhappychoice/oss-issue-opener/issues') {
        const issue = JSON.parse(options.body);
        const failedCheck = endpoint === 'check-suite' ? 'tests' : 'build';
        if (['[CI Failure] unhappychoice/example', '[CI Failure] irasutoya-tools/example'].includes(issue.title) && issue.body.includes('- ' + failedCheck)) {
          return Response.json({ number: 532, labels: ['ci-failure'] }, { status: 201 });
        }
      }
      if (options.method === 'GET') {
        if (pathname === '/users/unhappychoice/repos') {
          if (${failListing} && searchParams.get('page') === '2') {
            return Response.json({ message: 'Repository listing unavailable' }, { status: 503 });
          }
          const headers = ${failListing} ? { link: '<https://api.github.com/users/unhappychoice/repos?page=2>; rel="next"' } : {};
          return Response.json([{ full_name: 'unhappychoice/example', default_branch: 'main' }], { headers });
        }
        if (${failListing} && pathname === '/users/irasutoya-tools/repos') {
          return Response.json([{ full_name: 'irasutoya-tools/example', default_branch: 'main' }]);
        }
        if (pathname.startsWith('/users/')) {
          return Response.json(pathname.endsWith('/repos') ? [] : { type: 'User' });
        }
        if (pathname.endsWith('/example/branches/main')) {
          return Response.json({ commit: { sha: '${sha}', commit: { tree: { sha: 'head-tree' } } } });
        }
        if (pathname.endsWith('/example/commits/${sha}/status')) {
          if (endpoint === 'statuses') {
            if (searchParams.get('page') === '2') {
              return Response.json({ message: 'CI page unavailable' }, { status: 503 });
            }
            return Response.json({ statuses: Array.from({ length: 100 }, (_, index) => ({
              state: ${hasFailure} && index === 0 ? 'failure' : 'success', context: index === 0 ? 'build' : 'lint-' + index,
            })) });
          }
          return Response.json({ statuses: (endpoint === 'first-check-page' || endpoint === 'listing')
            ? [{ state: 'failure', context: 'build' }] : [] });
        }
        if (pathname.endsWith('/example/commits/${sha}/check-suites')) {
          if (endpoint === 'check-suite') {
            const checkSuites = [{ id: 1 }, { id: 2 }].slice(0, Number(searchParams.get('per_page')));
            return respond({ total_count: 1001, check_suites: checkSuites });
          }
          return Response.json({ total_count: 0, check_suites: [] });
        }
        if (endpoint === 'check-suite' && pathname.endsWith('/example/check-suites/1/check-runs')) {
          return Response.json({ message: 'CI page unavailable' }, { status: 503 });
        }
        if (endpoint === 'check-suite' && pathname.endsWith('/example/check-suites/2/check-runs')) {
          return respond({
            total_count: 1, check_runs: [{ name: 'tests', status: 'completed', conclusion: 'failure' }],
          });
        }
        if (pathname.endsWith('/example/commits/${sha}/check-runs')) {
          if (endpoint === 'first-check-page' || searchParams.get('page') === '2') {
            return Response.json({ message: 'CI page unavailable' }, { status: 503 });
          }
          if (endpoint === 'statuses' || endpoint === 'listing') return respond({ total_count: 0, check_runs: [] });
          const next = new URL(url);
          next.searchParams.set('page', '2');
          return respond({
            total_count: 101,
            check_runs: Array.from({ length: 100 }, (_, index) => ({
              status: 'completed',
              conclusion: ${hasFailure} && index === 0 ? 'failure' : 'success',
              name: index === 0 ? 'build' : 'lint-' + index,
            })),
          }, { headers: { link: '<' + next + '>; rel="next"' } });
        }
        if (['/releases', '/tags', '/issues'].some((suffix) => pathname.endsWith(suffix))) {
          return Response.json([]);
        }
      }
      throw new Error('Unexpected GitHub request: ' + options.method + ' ' + url);
    };
  `;
  return spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, entryPoint], {
    env: { ...process.env, GH_TOKEN: 'test-token' }, encoding: 'utf8',
  });
};

[
  ['first-check-page', true],
  ['statuses', true],
  ['statuses', false],
  ['check-runs', true],
  ['check-runs', false],
  ['check-suite', true],
].forEach(([endpoint, hasFailure]) => {
  test(`CLI exits with status 1 after a ${endpoint} error with ${hasFailure ? 'a confirmed failure' : 'no confirmed failures'}`, () => {
    const result = runCLIWithCIFailures(endpoint, hasFailure);

    assert.ifError(result.error);
    assert.equal(result.status, 1);
    if (hasFailure) {
      assert.match(result.stdout, /CI: failure/, result.stderr);
      assert.match(result.stdout, /\[created\] \[CI Failure\] unhappychoice\/example/, result.stderr);
    } else {
      assert.match(result.stdout, /CI: incomplete/);
      assert.match(result.stdout, /CI failures: 0/);
    }
    assert.match(result.stderr, /CI page unavailable/);
    assert.match(result.stderr, /\[failed\] unhappychoice\/example: CI investigation/);
    assert.match(result.stderr, /status: 503/);
    assert.match(result.stderr, /Fatal error: AggregateError: Failed 1 maintenance operations/);
  });
});

test('CLI scans earlier listing pages and subsequent accounts after a listing page fails', () => {
  const result = runCLIWithCIFailures('listing');

  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /\[created\] \[CI Failure\] unhappychoice\/example/, result.stderr);
  assert.match(result.stdout, /\[created\] \[CI Failure\] irasutoya-tools\/example/, result.stderr);
  assert.match(result.stderr, /\[failed\] unhappychoice: repository investigation/);
  assert.match(result.stderr, /Repository listing unavailable/);
  assert.match(result.stderr, /status: 503/);
  assert.match(result.stderr, /Fatal error: AggregateError: Failed 1 maintenance operations/);
});
