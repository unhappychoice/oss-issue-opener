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
  assert.match(result.stderr, /Fatal error: AggregateError: Failed 1 investigation or creation operations/);
});
