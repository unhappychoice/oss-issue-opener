import { getDefaultBranchHead, listOrgRepos } from './github.js';
import { detectProjectTypes } from './project-type.js';
import { checkCIStatus, checkPendingRelease } from './checker.js';
import { createConcurrencyLimiter } from './concurrency-limiter.js';
import { buildCIFailureIssue, buildPendingReleaseIssue, closeRecoveredCIAlerts, createIssuesInBatch, getCIAlertRepositories, listCIAlerts } from './issue.js';
import { ORGS, type CIStatus, type Repository, type PendingIssue } from './types.js';

const defaultDependencies = { listOrgRepos, detectProjectTypes, checkCIStatus, checkPendingRelease, createIssuesInBatch };
type Dependencies = typeof defaultDependencies;

const REPO_CONCURRENCY = 8;

export const runChecks = async (
  deps: Dependencies = defaultDependencies,
  autoCloseCIAlerts = process.env.AUTO_CLOSE_CI_ALERTS === 'true'
): Promise<void> => {
  const failures: Error[] = [];
  const allIssues: PendingIssue[] = [];
  const recoveries = new Map<string, NonNullable<CIStatus['recovery']>>();
  const alerts = autoCloseCIAlerts
    ? await attempt('open CI alert lookup', failures, listCIAlerts, [])
    : [];
  const alertRepositories = getCIAlertRepositories(alerts);
  let totalRepos = 0;

  for (const org of ORGS) {
    console.log(`\n━━━ Organization: ${org} ━━━`);

    const scan = createConcurrencyLimiter(REPO_CONCURRENCY);
    const scans: Promise<PendingIssue[]>[] = [];
    await attempt(`${org}: repository investigation`, failures, async () => {
      for await (const repo of deps.listOrgRepos(org)) {
        scans.push(scan(() => attempt(
          `${repo.fullName}: repository investigation`, failures, () => checkRepo(repo, deps, failures, recoveries, alertRepositories.has(repo.fullName)), []
        )));
      }
    });
    console.log(`  Found ${scans.length} repositories`);
    totalRepos += scans.length;
    const issuesByRepo = await Promise.all(scans);
    allIssues.push(...issuesByRepo.flat());
  }

  if (allIssues.length > 0) {
    await attempt('issue batch creation', failures, () => deps.createIssuesInBatch(allIssues));
  }

  if (alerts.length > 0 && recoveries.size > 0) {
    await attempt('CI alert closure', failures, () => closeRecoveredCIAlerts(alerts, recoveries));
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
    throw new AggregateError(failures, `Failed ${failures.length} maintenance operations`);
  }
};

const attempt = async <T = void>(
  target: string, failures: Error[], action: () => Promise<T>, fallback: T = undefined as T
): Promise<T> => {
  try {
    return await action();
  } catch (cause) {
    recordFailure(target, failures, cause);
    return fallback;
  }
};

const recordFailure = (target: string, failures: Error[], cause: unknown): void => {
  failures.push(new Error(`Failed ${target}`, { cause }));
  console.error(`  [failed] ${target}`, cause);
};

const log = (icon: string, msg: string) => console.log(`  ${icon} ${msg}`);

const checkRepo = async (
  { fullName, defaultBranch: listedBranch }: Repository, deps: Dependencies, failures: Error[],
  recoveries: Map<string, NonNullable<CIStatus['recovery']>>, verifyRecovery: boolean
): Promise<PendingIssue[]> => {
  const [owner, repo] = fullName.split('/') as [string, string];
  let head: ReturnType<typeof getDefaultBranchHead> | undefined;
  const getHead = () => head ??= getDefaultBranchHead(owner, repo, listedBranch);

  console.log(`\n📦 ${repo}`);

  const [ciIssues, releaseIssues] = await Promise.all([
    attempt<PendingIssue[]>(`${fullName}: CI investigation`, failures, async () => {
      const ciResult = await deps.checkCIStatus(owner, repo, getHead, verifyRecovery);
      ciResult.endpointErrors?.forEach((cause) => recordFailure(`${fullName}: CI investigation`, failures, cause));
      const ciIcons = { success: '✅', failure: '❌', pending: '⏳', 'no-ci': '⚪', 'no-branch': '⚪', incomplete: '⚠️' };
      log(ciIcons[ciResult.status], `CI: ${ciResult.status}`);

      if (ciResult.status === 'success' && ciResult.recovery) recoveries.set(fullName, ciResult.recovery);
      return ciResult.status === 'failure'
        ? [buildCIFailureIssue(fullName, ciResult.failedChecks, !ciResult.endpointErrors?.length)]
        : [];
    }, []),

    attempt<PendingIssue[]>(`${fullName}: release investigation`, failures, async () => {
      const getProjectTypes = async (getContents: () => Promise<string[]>) => {
        const types = await deps.detectProjectTypes(owner, repo, getContents);
        log('📋', `Types: ${types.join(', ')}`);
        return types;
      };
      const releaseStatus = await deps.checkPendingRelease(owner, repo, getProjectTypes, getHead);
      releaseStatus.lookupErrors?.forEach((cause) => recordFailure(`${fullName}: release investigation`, failures, cause));
      if (releaseStatus.status === 'no-tag') {
        log('⚪', 'Release: no tags found');
        return [];
      } else if (releaseStatus.status === 'up-to-date') {
        log('✅', 'Release: up to date');
        return [];
      } else if (releaseStatus.status === 'incomplete') {
        log('⚠️', 'Release: incomplete');
        return [];
      } else if (releaseStatus.status !== 'pending') {
        log('⚪', `Release: ${releaseStatus.status}`);
        return [];
      }
      log('📦', 'Release: pending');
      return [buildPendingReleaseIssue(fullName, releaseStatus.changedSources, releaseStatus.dependencyUpdates, releaseStatus.compareUrl)];
    }, []),
  ]);

  return [...ciIssues, ...releaseIssues];
};

