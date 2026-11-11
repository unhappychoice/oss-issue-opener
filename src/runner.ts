import { listOrgRepos } from './github.js';
import { detectProjectType } from './project-type.js';
import { checkCIStatus, checkPendingRelease } from './checker.js';
import { buildCIFailureIssue, buildPendingReleaseIssue, createIssuesInBatch } from './issue.js';
import { ORGS, type PendingIssue } from './types.js';

const defaultDependencies = { listOrgRepos, detectProjectType, checkCIStatus, checkPendingRelease, createIssuesInBatch };
type Dependencies = typeof defaultDependencies;

export const runChecks = async (deps: Dependencies = defaultDependencies): Promise<void> => {
  const failures: Error[] = [];
  const allIssues: PendingIssue[] = [];
  let totalRepos = 0;

  for (const org of ORGS) {
    console.log(`\n━━━ Organization: ${org} ━━━`);

    await attempt(`${org}: repository investigation`, failures, async () => {
      const repos = await deps.listOrgRepos(org);
      console.log(`  Found ${repos.length} repositories`);

      for (const repo of repos) {
        totalRepos++;
        await attempt(`${repo}: repository investigation`, failures, async () => {
          const issues = await checkRepo(repo, deps, failures);
          allIssues.push(...issues);
        });
      }
    });
  }

  if (allIssues.length > 0) {
    await attempt('issue batch creation', failures, () => deps.createIssuesInBatch(allIssues));
  }

  const ciFailures = allIssues.filter((i) => i.type === 'ci-failure').length;
  const pendingReleases = allIssues.filter((i) => i.type === 'pending-release').length;

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📊 Summary');
  console.log(`  Total repositories: ${totalRepos}`);
  console.log(`  CI failures: ${ciFailures}`);
  console.log(`  Pending releases: ${pendingReleases}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (failures.length > 0) {
    throw new AggregateError(failures, `Failed ${failures.length} investigation or creation operations`);
  }
};

const attempt = async (target: string, failures: Error[], action: () => Promise<void>): Promise<void> => {
  try {
    await action();
  } catch (cause) {
    failures.push(new Error(`Failed ${target}`, { cause }));
    console.error(`  [failed] ${target}`, cause);
  }
};

const log = (icon: string, msg: string) => console.log(`  ${icon} ${msg}`);

const checkRepo = async (fullName: string, deps: Dependencies, failures: Error[]): Promise<PendingIssue[]> => {
  const [owner, repo] = fullName.split('/') as [string, string];
  const issues: PendingIssue[] = [];

  console.log(`\n📦 ${repo}`);

  await attempt(`${fullName}: CI investigation`, failures, async () => {
    const ciResult = await deps.checkCIStatus(owner, repo);
    const ciIcons = { success: '✅', failure: '❌', pending: '⏳', 'no-ci': '⚪', 'no-branch': '⚪' };
    log(ciIcons[ciResult.status], `CI: ${ciResult.status}`);

    if (ciResult.status === 'failure') {
      issues.push(buildCIFailureIssue(fullName, ciResult.failedChecks));
    }
  });

  await attempt(`${fullName}: release investigation`, failures, async () => {
    const projectType = await deps.detectProjectType(owner, repo);
    log('📋', `Type: ${projectType}`);

    const releaseStatus = await deps.checkPendingRelease(owner, repo, projectType);
    if (releaseStatus.status === 'no-tag') {
      log('⚪', 'Release: no tags found');
    } else if (releaseStatus.status === 'up-to-date') {
      log('✅', 'Release: up to date');
    } else {
      log('📦', 'Release: pending');
      issues.push(buildPendingReleaseIssue(fullName, releaseStatus.reasons, releaseStatus.compareUrl));
    }
  });

  return issues;
};

