import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const readRepositoryFile = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const workflowCommands = (workflow) => [...workflow.matchAll(/^\s+run: (npm .+)$/gm)]
  .map(([, command]) => command)
  .filter((command) => command !== 'npm ci');

test('contributor and architecture guides match the workflow commands', async () => {
  const [contributing, architecture, weekly, pullRequest] = await Promise.all([
    readRepositoryFile('CONTRIBUTING.md'),
    readRepositoryFile('docs/architecture.md'),
    readRepositoryFile('.github/workflows/weekly.yml'),
    readRepositoryFile('.github/workflows/test.yml'),
  ]);
  const weeklySequence = workflowCommands(weekly).map((command) => `\`${command}\``).join(' followed by ');
  assert.ok(contributing.replace(/\s+/g, ' ').includes(`runs ${weeklySequence}`));
  assert.ok(architecture.replace(/\s+/g, ' ').includes(`runs ${weeklySequence}`));
  assert.ok(architecture.includes(`runs \`${workflowCommands(pullRequest).join('\`, \`')}\` on pull requests`));
});
