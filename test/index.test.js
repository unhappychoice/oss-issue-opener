import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('CLI exits with an error when GH_TOKEN is missing', () => {
  const env = { ...process.env };
  delete env.GH_TOKEN;
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../dist/index.js', import.meta.url))], {
    env, encoding: 'utf8',
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '❌ Error: GH_TOKEN is not set\n');
});
