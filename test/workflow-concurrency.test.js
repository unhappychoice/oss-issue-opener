import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('scheduled and manual scans share a fixed concurrency group without cancellation', async () => {
  const workflow = await readFile(new URL('../.github/workflows/weekly.yml', import.meta.url), 'utf8');
  assert.match(workflow, /^on:\n(?:[ \t].*\n|\n)*  schedule:/m);
  assert.match(workflow, /^  workflow_dispatch:/m);
  assert.match(workflow, /^concurrency:\n  group: oss-issue-opener-notifications\n  cancel-in-progress: false\n/m);
});
