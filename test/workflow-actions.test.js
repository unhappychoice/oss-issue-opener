import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

for (const name of ['test', 'weekly']) {
  test(`${name} workflow pins checkout and setup-node to release commits`, async () => {
    const workflow = await readFile(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8');
    const actionSteps = workflow.match(/^ *- uses: actions\/(?:checkout|setup-node)@.*$/gm) ?? [];

    assert.equal(actionSteps.length, 2);
    assert.match(actionSteps[0], /^ *- uses: actions\/checkout@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
    assert.match(actionSteps[1], /^ *- uses: actions\/setup-node@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
    assert.match(workflow, /^      - uses: actions\/checkout@.*\n        with:\n          persist-credentials: false$/m);
    assert.match(workflow, /^      - uses: actions\/setup-node@.*\n        with:\n          node-version-file: \.node-version\n          cache: 'npm'$/m);
  });
}

test('Dependabot updates GitHub Actions at the repository root', async () => {
  const config = await readFile(new URL('../.github/dependabot.yml', import.meta.url), 'utf8');
  assert.match(config, /^  - package-ecosystem: github-actions\n    directory: "\/"$/m);
});
