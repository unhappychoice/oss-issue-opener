import { initOctokit, listOrgRepos } from './github.js';
import { detectProjectType } from './project-type.js';
import { checkCIStatus, checkPendingRelease } from './checker.js';
import { buildCIFailureIssue, buildPendingReleaseIssue, createIssuesInBatch } from './issue.js';
import { ORGS, type PendingIssue } from './types.js';

const log = (icon: string, msg: string) => console.log(`  ${icon} ${msg}`);

const checkRepo = async (fullName: string): Promise<PendingIssue[]> => {
  const [owner, repo] = fullName.split('/') as [string, string];
  const issues: PendingIssue[] = [];

  console.log(`\n📦 ${repo}`);

  const projectType = await detectProjectType(owner, repo);
  log('📋', `Type: ${projectType}`);

  const ciStatus = await checkCIStatus(owner, repo);
  const ciIcons = { success: '✅', failure: '❌', pending: '⏳', 'no-ci': '⚪', 'no-branch': '⚪' };
  log(ciIcons[ciStatus], `CI: ${ciStatus}`);

  if (ciStatus === 'failure') {
    issues.push(buildCIFailureIssue(fullName));
  }

  const releaseStatus = await checkPendingRelease(owner, repo, projectType);
  if (releaseStatus.status === 'no-tag') {
    log('⚪', 'Release: no tags found');
  } else if (releaseStatus.status === 'up-to-date') {
    log('✅', 'Release: up to date');
  } else {
    log('📦', 'Release: pending');
    issues.push(buildPendingReleaseIssue(fullName, releaseStatus.reasons));
  }

  return issues;
};

const main = async (): Promise<void> => {
  const token = process.env.GH_TOKEN;
  if (!token) {
    console.error('❌ Error: GH_TOKEN is not set');
    process.exit(1);
  }

  initOctokit(token);
  console.log('✅ GitHub authentication initialized\n');

  const allIssues: PendingIssue[] = [];
  let totalRepos = 0;

  for (const org of ORGS) {
    console.log(`\n━━━ Organization: ${org} ━━━`);

    const repos = await listOrgRepos(org);
    console.log(`  Found ${repos.length} repositories`);

    for (const repo of repos) {
      totalRepos++;
      const issues = await checkRepo(repo);
      allIssues.push(...issues);
    }
  }

  if (allIssues.length > 0) {
    await createIssuesInBatch(allIssues);
  }

  const ciFailures = allIssues.filter((i) => i.type === 'ci-failure').length;
  const pendingReleases = allIssues.filter((i) => i.type === 'pending-release').length;

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📊 Summary');
  console.log(`  Total repositories: ${totalRepos}`);
  console.log(`  CI failures: ${ciFailures}`);
  console.log(`  Pending releases: ${pendingReleases}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━');
};

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
