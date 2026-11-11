import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { runChecks } from '../dist/runner.js';
import { checkPendingRelease } from '../dist/checker.js';
import { getOctokit, initOctokit } from '../dist/github.js';

beforeEach(() => {
  mock.method(console, 'log', () => {});
  mock.method(console, 'error', () => {});
});
afterEach(() => mock.restoreAll());

const setup = (overrides = {}) => {
  const batches = [];
  const checked = [];
  const deps = {
    listOrgRepos: async (org) => org === 'unhappychoice'
      ? ['owner/first', 'owner/broken', 'owner/last'] : [],
    detectProjectType: async () => 'node',
    checkCIStatus: async (_owner, repo) => {
      checked.push(repo);
      return { status: 'failure', failedChecks: [] };
    },
    checkPendingRelease: async () => ({ status: 'pending', reasons: 'Source changes', compareUrl: 'https://example.com/compare' }),
    createIssuesInBatch: async (issues) => { batches.push(issues); },
    ...overrides,
  };
  return { deps, batches, checked };
};

const expectFailures = async (deps, expected) => {
  await assert.rejects(runChecks(deps), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors.map(({ message, cause }) => [message, cause]), expected);
    return true;
  });
};

test('creates accumulated and same-repository CI notifications after a comparison failure', async () => {
  const cause = new Error('comparison HTTP 404');
  initOctokit('test-token');
  mock.method(getOctokit().repos, 'get', async () => ({ data: { default_branch: 'main' } }));
  mock.method(getOctokit().repos, 'listReleases', async () => ({ data: [{ tag_name: 'v1' }] }));
  const compared = [];
  mock.method(getOctokit().repos, 'compareCommits', async ({ repo }) => {
    compared.push(repo);
    if (repo === 'broken') throw cause;
    return { data: { files: [{ filename: 'src/example.ts' }], commits: [] } };
  });
  const { deps, batches, checked } = setup({ checkPendingRelease });

  await expectFailures(deps, [['Failed owner/broken: release investigation', cause]]);

  assert.deepEqual(checked, ['first', 'broken', 'last']);
  assert.deepEqual(compared, ['first', 'broken', 'last']);
  assert.deepEqual(batches.map((issues) => issues.map(({ repo, type }) => [repo, type])), [[
    ['owner/first', 'ci-failure'], ['owner/first', 'pending-release'],
    ['owner/broken', 'ci-failure'],
    ['owner/last', 'ci-failure'], ['owner/last', 'pending-release'],
  ]]);
  assert.equal(console.error.mock.calls[0].arguments[1], cause);
});

test('still checks releases when CI investigation fails', async () => {
  const cause = new Error('CI unavailable');
  const { deps, batches } = setup({ checkCIStatus: async () => { throw cause; } });

  await expectFailures(deps, ['first', 'broken', 'last'].map((repo) => [
    `Failed owner/${repo}: CI investigation`, cause,
  ]));

  assert.deepEqual(batches[0].map(({ type }) => type), Array(3).fill('pending-release'));
});

test('preserves CI notifications when project detection fails', async () => {
  const cause = new Error('Project detection unavailable');
  const release = mock.fn(async () => { throw new Error('Should not run'); });
  const { deps, batches, checked } = setup({
    detectProjectType: async () => { throw cause; },
    checkPendingRelease: release,
  });

  await expectFailures(deps, ['first', 'broken', 'last'].map((repo) => [
    `Failed owner/${repo}: release investigation`, cause,
  ]));

  assert.deepEqual(checked, ['first', 'broken', 'last']);
  assert.deepEqual(batches[0].map(({ type }) => type), Array(3).fill('ci-failure'));
  assert.equal(release.mock.callCount(), 0);
});

test('continues other organizations and reports investigation and batch failures together', async () => {
  const lookup = new Error('Repository lookup unavailable');
  const comparison = new Error('Comparison unavailable');
  const creation = new Error('Issue creation unavailable');
  const organizations = [];
  const { deps } = setup({
    listOrgRepos: async (org) => {
      organizations.push(org);
      if (org === 'unhappychoice') throw lookup;
      return org === 'irasutoya-tools' ? ['owner/repo'] : [];
    },
    checkPendingRelease: async () => { throw comparison; },
    createIssuesInBatch: async (issues) => {
      assert.equal(issues[0].type, 'ci-failure');
      throw creation;
    },
  });

  await expectFailures(deps, [
    ['Failed unhappychoice: repository investigation', lookup],
    ['Failed owner/repo: release investigation', comparison],
    ['Failed issue batch creation', creation],
  ]);
  assert.deepEqual(organizations, ['unhappychoice', 'irasutoya-tools', 'bitflyer-tools', 'circleci-tools']);
});

test('completes successfully when investigations and creation succeed', async () => {
  const { deps, batches } = setup();
  await runChecks(deps);
  assert.equal(batches[0].length, 6);
});

test('reports failures even when there are no notifications to create', async () => {
  const cause = new Error('Comparison unavailable');
  const create = mock.fn();
  const { deps } = setup({
    checkCIStatus: async () => ({ status: 'success', failedChecks: [] }),
    checkPendingRelease: async () => { throw cause; },
    createIssuesInBatch: create,
  });
  await expectFailures(deps, ['first', 'broken', 'last'].map((repo) => [
    `Failed owner/${repo}: release investigation`, cause,
  ]));
  assert.equal(create.mock.callCount(), 0);
});
