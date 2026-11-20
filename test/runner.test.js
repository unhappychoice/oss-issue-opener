import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { runChecks } from '../dist/runner.js';
import { checkCIStatus, checkPendingRelease } from '../dist/checker.js';
import { getOctokit, listOrgRepos } from '../dist/github.js';
import { detectProjectTypes } from '../dist/project-type.js';
import { commitSha, initMockOctokit, mockCommitFiles } from './helpers/github.mjs';

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
      ? ['first', 'broken', 'last'].map((repo) => ({ fullName: `owner/${repo}` })) : [],
    detectProjectTypes: async () => ['node'],
    checkCIStatus: async (_owner, repo) => {
      checked.push(repo);
      return { status: 'failure', failedChecks: [] };
    },
    checkPendingRelease: async () => ({
      status: 'pending', changedSources: ['src/example.ts'], dependencyUpdates: [], compareUrl: 'https://example.com/compare',
    }),
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

test('preserves GitHub read failures and waits for the remaining notifications', async () => {
  const checksFailure = new Error('Check runs HTTP 503');
  const statusesFailure = new Error('Commit statuses HTTP 503');
  const releasesFailure = new Error('Releases HTTP 503');
  initMockOctokit('test-token');
  const client = getOctokit();
  mock.method(client.repos, 'getBranch', async ({ repo }) => ({ data: { commit: { sha: headSha(repo), commit: { tree: { sha: 'head-tree' } } } } }));
  mock.method(client.repos, 'get', async () => ({ data: { default_branch: 'main' } }));
  mock.method(client.repos, 'getCombinedStatusForRef', async ({ repo }) => {
    if (repo === 'last') throw statusesFailure;
    return { data: { statuses: [{ state: 'failure', context: 'build' }] } };
  });
  mock.method(client, 'paginate', async (_route, { repo }) => {
    if (repo === 'broken') throw checksFailure;
    return repo === 'last' ? [{ status: 'completed', conclusion: 'failure', name: 'test suite' }] : [];
  });
  mock.method(client.repos, 'listReleases', async ({ repo }) => {
    if (repo === 'first') throw releasesFailure;
    return { data: [{ tag_name: 'v1' }] };
  });
  mock.method(client.repos, 'compareCommits', async () => ({ data: {
    files: [{ filename: 'src/example.ts' }], commits: [],
  } }));
  const { deps, batches } = setup({ checkCIStatus, checkPendingRelease });
  const submit = deps.createIssuesInBatch;
  deps.createIssuesInBatch = async (issues) => {
    await new Promise((resolve) => setImmediate(resolve));
    await submit(issues);
  };

  await assert.rejects(runChecks(deps), (error) => {
    assert.ok(error instanceof AggregateError);
    const causes = new Map(error.errors.map(({ message, cause }) => [message, cause]));
    assert.equal(error.errors.length, 3);
    assert.equal(causes.get('Failed owner/broken: CI investigation'), checksFailure);
    assert.equal(causes.get('Failed owner/last: CI investigation'), statusesFailure);
    assert.equal(causes.get('Failed owner/first: release investigation'), releasesFailure);
    assert.deepEqual(batches.map((issues) => issues.map(({ repo, type }) => [repo, type])), [[
      ['owner/first', 'ci-failure'],
      ['owner/broken', 'ci-failure'], ['owner/broken', 'pending-release'],
      ['owner/last', 'ci-failure'], ['owner/last', 'pending-release'],
    ]]);
    assert.match(batches[0].find(({ repo, type }) => repo === 'owner/broken' && type === 'ci-failure').body, /build/);
    assert.match(batches[0].find(({ repo, type }) => repo === 'owner/last' && type === 'ci-failure').body, /test suite/);
    return true;
  });
});

test('creates accumulated and same-repository CI notifications after a comparison failure', async () => {
  const cause = new Error('comparison HTTP 404');
  initMockOctokit('test-token');
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

test('runs the CI and release investigations for a repository concurrently', async () => {
  let resolveCI;
  let releaseStartedBeforeCIFinished = false;
  const { deps } = setup({
    listOrgRepos: async (org) => org === 'unhappychoice' ? [{ fullName: 'owner/repo' }] : [],
    checkCIStatus: async () => new Promise((resolve) => {
      resolveCI = () => resolve({ status: 'success', failedChecks: [] });
    }),
    detectProjectTypes: async () => {
      releaseStartedBeforeCIFinished = resolveCI !== undefined;
      resolveCI();
      return ['node'];
    },
    checkPendingRelease: async (_owner, _repo, getProjectTypes) => {
      await getProjectTypes();
      return { status: 'up-to-date' };
    },
  });

  await runChecks(deps);

  assert.equal(releaseStartedBeforeCIFinished, true);
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
  const repos = stubInvestigations();
  mock.method(repos, 'get', async () => ({ data: { default_branch: 'main' } }));
  mock.method(repos, 'compareCommits', async () => ({ data: {
    files: [{ filename: 'src/example.ts' }], commits: [],
  } }));
  const { deps, batches, checked } = setup({
    detectProjectTypes: async () => { throw cause; },
    checkPendingRelease,
  });

  await expectFailures(deps, ['first', 'broken', 'last'].map((repo) => [
    `Failed owner/${repo}: release investigation`, cause,
  ]));

  assert.deepEqual(checked, ['first', 'broken', 'last']);
  assert.deepEqual(batches[0].map(({ type }) => type), Array(3).fill('ci-failure'));
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
      return org === 'irasutoya-tools' ? [{ fullName: 'owner/repo' }] : [];
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

test('investigates repositories within an organization concurrently instead of one at a time', async () => {
  const pending = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const { deps } = setup({
    checkCIStatus: async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => pending.push(resolve));
      inFlight--;
      return { status: 'success', failedChecks: [] };
    },
    checkPendingRelease: async () => ({ status: 'up-to-date' }),
  });

  const result = runChecks(deps);
  while (pending.length < 3) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maxInFlight, 3);

  pending.forEach((resolve) => resolve());
  await result;
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

const headSha = (repo) => Buffer.from(repo).toString('hex').padEnd(40, '0');

const stubInvestigations = (releases = [{ tag_name: 'v1' }]) => {
  initMockOctokit('test-token');
  const client = getOctokit();
  mock.method(client.repos, 'listReleases', async () => ({ data: releases }));
  mock.method(client.repos, 'getBranch', async ({ repo }) => ({ data: { commit: { sha: headSha(repo), commit: { tree: { sha: 'head-tree' } } } } }));
  mock.method(client.repos, 'getCombinedStatusForRef', async () => ({ data: { statuses: [
    { state: 'failure', context: 'build', target_url: 'https://example.com/build' },
  ] } }));
  mock.method(client, 'paginate', async () => []);
  return client.repos;
};

test('shares default branch heads per repository and refreshes them on each scan', async () => {
  const repos = stubInvestigations();
  let branch = 'main';
  const lookup = mock.method(repos, 'get', async () => ({ data: { default_branch: branch } }));
  const getBranch = mock.method(repos, 'getBranch', async ({ repo, branch }) => {
    const sha = commitSha(`${repo}/${branch}`);
    return { data: { commit: { sha, commit: { tree: { sha: `${sha}-tree` } } } } };
  });
  const compared = mock.method(repos, 'compareCommits', async ({ page }) => ({ data: page === 1 ? {
    files: Array.from({ length: 300 }, (_, index) => ({ filename: `docs/${index}.md` })),
    merge_base_commit: { commit: { tree: { sha: 'merge-base-tree' } } },
    commits: Array.from({ length: 100 }, (_, index) => ({ sha: `commit-${index}`, commit: { message: 'docs: update' } })),
  } : { commits: [] } }));
  const trees = mock.method(getOctokit().git, 'getTree', async ({ tree_sha }) => ({ data: {
    truncated: false,
    tree: tree_sha === 'merge-base-tree' ? [] : [{ path: 'src/example.ts', type: 'blob', mode: '100644', sha: 'new' }],
  } }));
  const { deps, batches } = setup({ checkCIStatus, checkPendingRelease });

  await runChecks(deps);
  branch = 'next';
  await runChecks(deps);

  assert.deepEqual(lookup.mock.calls.map(({ arguments: [params] }) => params),
    [...Array(2)].flatMap(() => ['first', 'broken', 'last'].map((repo) => ({ owner: 'owner', repo }))));
  const expectedHeads = ['main', 'next'].flatMap((branch) => ['first', 'broken', 'last'].map((repo) => commitSha(`${repo}/${branch}`)));
  assert.equal(getBranch.mock.callCount(), expectedHeads.length);
  assert.deepEqual(repos.getCommit.mock.calls.map(({ arguments: [{ ref }] }) => ref), Array(6).fill('tags/v1'));
  assert.deepEqual(repos.getCombinedStatusForRef.mock.calls.map(({ arguments: [{ ref }] }) => ref), expectedHeads);
  assert.deepEqual(getOctokit().paginate.mock.calls.map(({ arguments: [_, { ref }] }) => ref), expectedHeads);
  const pages = compared.mock.calls.map(({ arguments: [{ head, page }] }) => [head, page]);
  assert.deepEqual(pages.filter(([, page]) => page === 1), expectedHeads.map((head) => [head, 1]));
  assert.deepEqual(pages.filter(([, page]) => page === 2), expectedHeads.map((head) => [head, 2]));
  assert.deepEqual(trees.mock.calls.map(({ arguments: [{ tree_sha }] }) => tree_sha),
    expectedHeads.flatMap((head) => ['merge-base-tree', `${head}-tree`]));
  batches.forEach((issues, scan) => {
    assert.equal(issues.length, 6);
    issues.filter(({ type }) => type === 'ci-failure').forEach(({ body }) => {
      assert.ok(body.includes('[build](https://example.com/build)'));
    });
    issues.filter(({ type }) => type === 'pending-release').forEach(({ body, repo }) => {
      assert.ok(body.includes('src/example.ts'));
      assert.ok(body.includes(`/compare/${commitSha('tags/v1')}...${commitSha(`${repo.split('/')[1]}/${scan === 0 ? 'main' : 'next'}`)}`));
    });
  });
});

test('shares the default branch when release comparison is empty', async () => {
  const repos = stubInvestigations();
  const lookup = mock.method(repos, 'get', async () => ({ data: { default_branch: 'main' } }));
  mock.method(repos, 'compareCommits', async () => ({ data: { files: [], commits: [] } }));
  const contents = mock.method(repos, 'getContent', async () => ({ data: [{ name: 'package.json' }] }));
  const { deps, batches } = setup({ checkCIStatus, checkPendingRelease, detectProjectTypes });

  await runChecks(deps);

  assert.equal(lookup.mock.callCount(), 3);
  assert.equal(contents.mock.callCount(), 0);
  assert.ok(console.log.mock.calls.every(({ arguments: [line] }) => !line.includes('Types:')));
  assert.deepEqual(batches[0].map(({ type }) => type), Array(3).fill('ci-failure'));
});

test('reports up to date without comparing or listing root contents when both refs resolve to the same commit', async () => {
  const repos = stubInvestigations();
  const resolve = mock.method(repos, 'getCommit', async () => ({ data: { sha: headSha('repo') } }));
  const compare = mock.method(repos, 'compareCommits', async () => assert.fail('Refs match'));
  const contents = mock.method(repos, 'getContent', async () => ({ data: [{ name: 'package.json' }] }));
  const { deps, batches } = setup({
    listOrgRepos: async (org) => org === 'unhappychoice' ? [{ fullName: 'owner/repo', defaultBranch: 'main' }] : [],
    checkCIStatus,
    checkPendingRelease,
    detectProjectTypes,
  });

  await runChecks(deps);

  assert.deepEqual(resolve.mock.calls.map(({ arguments: [{ ref }] }) => ref), ['tags/v1']);
  assert.equal(repos.getBranch.mock.callCount(), 1);
  assert.equal(compare.mock.callCount(), 0);
  assert.equal(contents.mock.callCount(), 0);
  assert.ok(console.log.mock.calls.some(({ arguments: [line] }) => line.includes('Release: up to date')));
  assert.deepEqual(batches[0].map(({ type }) => type), ['ci-failure']);
});

test('shares failed branch lookups without retrying or creating notifications', async () => {
  const repos = stubInvestigations();
  const lookup = mock.method(repos, 'get', async () => { throw new Error('Repository unavailable'); });
  const compared = mock.method(repos, 'compareCommits', async () => assert.fail('No branch to compare'));
  const { deps, batches } = setup({ checkCIStatus, checkPendingRelease });

  await runChecks(deps);
  await runChecks(deps);

  assert.equal(lookup.mock.callCount(), 6);
  assert.equal(compared.mock.callCount(), 0);
  assert.deepEqual(batches, []);
});

test('passes every detected ecosystem to the release check', async () => {
  const release = mock.fn(async (_owner, _repo, getProjectTypes) => {
    assert.deepEqual(await getProjectTypes(), ['node', 'ruby']);
    return { status: 'up-to-date' };
  });
  const { deps } = setup({
    detectProjectTypes: async () => ['node', 'ruby'],
    checkPendingRelease: release,
  });
  await runChecks(deps);
  assert.equal(release.mock.callCount(), 3);
});

test('skips root listings when neither releases nor tags provide a baseline', async () => {
  const repos = stubInvestigations([]);
  const tags = mock.method(repos, 'listTags', async () => ({ data: [] }));
  const contents = mock.method(repos, 'getContent', async () => ({ data: [{ name: 'package.json' }] }));
  const { deps, batches } = setup({
    checkCIStatus: async () => ({ status: 'success', failedChecks: [] }),
    checkPendingRelease,
    detectProjectTypes,
  });

  await runChecks(deps);

  assert.equal(repos.listReleases.mock.callCount(), 3);
  assert.equal(tags.mock.callCount(), 3);
  assert.equal(contents.mock.callCount(), 0);
  assert.equal(repos.getBranch.mock.callCount(), 0);
  assert.equal(console.log.mock.calls.filter(({ arguments: [line] }) => line.includes('Release: no tags found')).length, 3);
  assert.ok(console.log.mock.calls.every(({ arguments: [line] }) => !line.includes('Types:')));
  assert.deepEqual(batches, []);
});

test('notifies about a production bump at the compared head after the default branch advances', async () => {
  const repos = stubInvestigations();
  const pinnedHead = commitSha('heads/main');
  let branchHead = pinnedHead;
  mock.method(repos, 'getBranch', async () => ({
    data: { commit: { sha: branchHead, commit: { tree: { sha: 'head-tree' } } } },
  }));
  mock.method(repos, 'getCommit', async ({ ref }) => ({
    data: ref === 'bump'
      ? { files: [{ filename: 'package.json' }] }
      : { sha: commitSha(ref) },
  }));
  mock.method(repos, 'compareCommits', async ({ head }) => {
    assert.equal(head, pinnedHead);
    branchHead = commitSha('advanced');
    return { data: {
      files: [{ filename: 'package.json' }],
      commits: [{ sha: 'bump', commit: { message: 'Bump runtime from 1.0.0 to 1.1.0' } }],
    } };
  });
  const content = mock.method(repos, 'getContent', async ({ path, ref = branchHead }) => {
    const manifest = ref === pinnedHead
      ? { dependencies: { runtime: '1.1.0' } }
      : { devDependencies: { runtime: '1.1.0' } };
    return { data: path === ''
      ? [{ name: 'package.json' }]
      : { content: Buffer.from(JSON.stringify(manifest)).toString('base64') } };
  });
  const { deps, batches } = setup({
    listOrgRepos: async (org) => org === 'unhappychoice' ? [{ fullName: 'owner/repo', defaultBranch: 'main' }] : [],
    checkCIStatus: async () => ({ status: 'success', failedChecks: [] }),
    checkPendingRelease,
    detectProjectTypes,
  });

  await runChecks(deps);

  const issues = batches.flat();
  assert.deepEqual(issues.map(({ type }) => type), ['pending-release']);
  assert.match(issues[0].body, /runtime.*1\.0\.0.*1\.1\.0/);
  assert.ok(console.log.mock.calls.some(({ arguments: [line] }) => line.includes('Types: node')));
  assert.deepEqual(content.mock.calls.map(({ arguments: [{ path, ref }] }) => [path, ref]), [
    ['', pinnedHead], ['package.json', pinnedHead],
  ]);
});

test('reuses one root listing per repository after finding a tag baseline', async () => {
  const repos = stubInvestigations([]);
  const tags = mock.method(repos, 'listTags', async () => ({ data: [{ name: 'v1' }] }));
  mock.method(repos, 'get', async () => ({ data: { default_branch: 'main' } }));
  mockCommitFiles(mock, ['Gemfile.lock']);
  mock.method(repos, 'compareCommits', async () => ({ data: {
    files: [{ filename: 'Gemfile.lock' }],
    commits: [{ sha: 'bump', commit: { message: 'Bump rack from 3.0.0 to 3.1.0' } }],
  } }));
  const rootCalls = [];
  mock.method(repos, 'getContent', async ({ repo, path }) => {
    if (path === '') {
      assert.ok(tags.mock.calls.some(({ arguments: [params] }) => params.repo === repo));
      rootCalls.push(repo);
    }
    return {
      data: path === ''
        ? [{ name: 'Gemfile' }]
        : { content: Buffer.from("gem 'rack'\n").toString('base64') },
    };
  });
  const { deps, batches } = setup({ checkCIStatus, checkPendingRelease, detectProjectTypes });

  await runChecks(deps);

  assert.deepEqual(rootCalls.sort(), ['broken', 'first', 'last']);
  assert.equal(batches[0].filter(({ type }) => type === 'pending-release').length, 3);
});

const groovyBuild = "dependencies { implementation 'org.example:groovy:1.1' }";
const kotlinBuild = 'dependencies { implementation("org.example:kotlin:1.1") }';
[
  ['Kotlin DSL only', { 'build.gradle.kts': kotlinBuild }, ['build.gradle.kts'], 'kotlin'],
  ['Groovy only', { 'build.gradle': groovyBuild }, ['build.gradle'], 'groovy'],
  ['both manifests', { 'build.gradle': groovyBuild, 'build.gradle.kts': kotlinBuild }, ['build.gradle'], 'groovy'],
  ['empty Groovy manifest', { 'build.gradle': '', 'build.gradle.kts': kotlinBuild }, ['build.gradle', 'build.gradle.kts'], 'kotlin'],
].forEach(([name, manifests, paths, expectedDependency]) => {
  test(`scans Gradle dependency bumps with ${name}`, async () => {
    const repos = stubInvestigations();
    mockCommitFiles(mock, paths);
    mock.method(repos, 'compareCommits', async () => ({ data: {
      files: Object.keys(manifests).map((filename) => ({ filename })),
      commits: ['groovy', 'kotlin'].map((pkg) => ({ sha: pkg, commit: { message: `Bump org.example:${pkg} from 1.0 to 1.1` } })),
    } }));
    const content = mock.method(repos, 'getContent', async ({ path }) => {
      if (path === '') return { data: Object.keys(manifests).map((name) => ({ name })) };
      if (!Object.hasOwn(manifests, path)) throw new Error('Not found');
      return { data: { content: Buffer.from(manifests[path]).toString('base64') } };
    });
    const { deps, batches } = setup({
      listOrgRepos: async (org) => org === 'unhappychoice' ? [{ fullName: 'owner/repo', defaultBranch: 'main' }] : [],
      checkPendingRelease,
      detectProjectTypes,
    });

    await runChecks(deps);

    assert.deepEqual(content.mock.calls.map(({ arguments: [request] }) => request.path), ['', ...paths]);
    const releases = batches.flat().filter(({ type }) => type === 'pending-release');
    assert.equal(releases.length, 1);
    assert.deepEqual(releases[0].body.match(/org\.example:\w+/g), [`org.example:${expectedDependency}`]);
  });
});

['User', 'Organization'].forEach((accountType) => {
  test(`reuses branches from paginated ${accountType} listings and falls back only for missing metadata`, async () => {
    const repos = stubInvestigations();
    const client = getOctokit();
    mock.method(client.users, 'getByUsername', async () => ({ data: { type: accountType } }));
    const listed = Array.from({ length: 100 }, (_, index) => ({
      full_name: `owner/repo-${index}`, default_branch: `listed-${index}`,
    }));
    const missing = [undefined, null, ''].map((default_branch, index) => ({
      full_name: `owner/fallback-${index}`, default_branch,
    }));
    const iterator = mock.method(client.paginate, 'iterator', async function* (route, params) {
      assert.equal(route, accountType === 'User' ? repos.listForUser : repos.listForOrg);
      assert.equal(params.per_page, 100);
      if ((params.username ?? params.org) !== 'unhappychoice') return;
      yield { data: listed };
      yield { data: [...missing, ...['archived', 'private', 'fork'].map((flag) => ({
        full_name: `owner/${flag}`, default_branch: 'ignored', [flag]: true,
      }))] };
    });
    const lookup = mock.method(repos, 'get', async () => ({ data: { default_branch: 'fallback' } }));
    const compared = mock.method(repos, 'compareCommits', async () => ({ data: {
      files: [{ filename: 'src/example.ts' }], commits: [],
    } }));
    const { deps, batches } = setup({ listOrgRepos, checkCIStatus, checkPendingRelease });

    await runChecks(deps);

    assert.equal(iterator.mock.callCount(), 4);
    assert.deepEqual(lookup.mock.calls.map(({ arguments: [params] }) => params.repo),
      ['fallback-0', 'fallback-1', 'fallback-2']);
    const branches = [...listed.map(({ default_branch }) => default_branch), ...Array(3).fill('fallback')];
    const heads = repos.getBranch.mock.calls.map(({ arguments: [params] }) => params);
    assert.deepEqual(heads.map(({ branch }) => branch), branches);
    const shas = heads.map(({ repo }) => headSha(repo));
    assert.deepEqual(repos.getCombinedStatusForRef.mock.calls.map(({ arguments: [params] }) => params.ref), shas);
    assert.deepEqual(client.paginate.mock.calls.map(({ arguments: [_, params] }) => params.ref), shas);
    assert.deepEqual(compared.mock.calls.map(({ arguments: [params] }) => params.head),
      shas);
    assert.equal(batches[0].length, 206);
    batches[0].filter(({ type }) => type === 'ci-failure').forEach(({ body }) => {
      assert.ok(body.includes('[build](https://example.com/build)'));
    });
    batches[0].filter(({ type }) => type === 'pending-release').forEach(({ body }, index) => {
      assert.ok(body.includes('src/example.ts'));
      assert.ok(body.includes(`/compare/${commitSha('tags/v1')}...${shas[index]}`));
    });
  });
});
