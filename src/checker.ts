import { createConcurrencyLimiter } from './concurrency-limiter.js';
import { getCommitStatus, getCheckRuns, getDefaultBranchHead, getLatestRelease, compareCommits, getCommitFilePages, getRepoContents } from './github.js';
import type { CIResult, ComparedCommits } from './github.js';
import { createDependencyChecker } from './dependency.js';
import { getDependencyProjectTypes, getSourcePatterns } from './project-type.js';
import { recoveryCheckKey } from './types.js';
import type { CheckIdentity, CIStatus, DependencyUpdate, FailedCheck, ProjectType, ReleaseStatus } from './types.js';

// Share the lookup budget across repository scans, including paginated lookups.
const limitCommitFileLookup = createConcurrencyLimiter(16);

export const checkCIStatus = async (
  owner: string,
  repo: string,
  getHead = () => getDefaultBranchHead(owner, repo)
): Promise<CIStatus> => {
  const result = await getHead();
  if (result.status === 'no-branch') return { status: 'no-branch', failedChecks: [] };
  if (result.status === 'no-head') return { status: 'no-ci', failedChecks: [] };

  const { sha } = result.head;
  const results = await Promise.all([
    collectCIResults(getCommitStatus(owner, repo, sha)),
    collectCIResults(getCheckRuns(owner, repo, sha)),
  ]);

  const failedChecks = results.flatMap(({ failedChecks }) => failedChecks);
  const endpointErrors = results.flatMap(({ errors }) => errors);
  if (endpointErrors.length > 0) {
    return { status: failedChecks.length > 0 ? 'failure' : 'incomplete', failedChecks, endpointErrors };
  }
  if (failedChecks.length > 0) return { status: 'failure', failedChecks };
  if (results.some(({ hasPending }) => hasPending)) return { status: 'pending', failedChecks };
  if (!results.some(({ hasRelevant }) => hasRelevant)) return { status: 'no-ci', failedChecks };

  const passedChecks = results.flatMap(({ recovery }) => recovery.passedChecks());
  return { status: 'success', failedChecks, recovery: { sha, passedChecks } };
};

const checkIdentity = ({ context, source, workflowId, publisherId }: CIResult): CheckIdentity => ({
  name: context, source,
  ...(publisherId === undefined ? {} : { publisherId }),
  ...(workflowId === undefined ? {} : { workflowId }),
});

const collectCIResults = async (pages: AsyncIterable<CIResult[]>) => {
  const summary = {
    hasRelevant: false,
    hasPending: false,
    failedChecks: [] as FailedCheck[],
    errors: [] as unknown[],
    recovery: collectRecoveryChecks(),
  };

  try {
    for await (const page of pages) {
      for (const result of page) {
        if (/codecov/i.test(result.context)) continue;
        summary.hasRelevant = true;
        summary.hasPending ||= result.state === 'pending' || typeof result.context !== 'string' || result.context.length === 0;
        if (result.state === 'failure' || result.state === 'error') {
          summary.failedChecks.push({ ...checkIdentity(result), url: result.url });
        }
        if (!summary.hasPending && summary.failedChecks.length === 0) summary.recovery.add(result);
      }
    }
  } catch (error) {
    summary.errors.push(error);
  }
  return summary;
};

const collectRecoveryChecks = () => {
  const candidates: { identity: CheckIdentity; key: string }[] = [];
  const unpassed = new Set<string>();
  const unidentified = new Set<string>();

  return {
    add(result: CIResult) {
      const identity = checkIdentity(result);
      const key = recoveryCheckKey(identity);
      if (result.passed) {
        if (key) candidates.push({ identity, key });
      } else if (key) {
        unpassed.add(key);
      } else {
        unidentified.add(identity.name);
      }
    },
    passedChecks: () => candidates
      .filter(({ identity, key }) => !unpassed.has(key) &&
        (identity.source === 'status' || !unidentified.has(identity.name)))
      .map(({ identity }) => identity),
  };
};

type GetContents = () => Promise<string[]>;

const parseBumpCommit = (msg: string): DependencyUpdate | null => {
  const match = msg.match(/^(?:[a-z]+(?:\([^\r\n)]+\))?!?: )?bump (\S+) from (\S+) to (\S+)/i);
  return match ? { pkg: match[1], from: match[2], to: match[3] } : null;
};

export const checkPendingRelease = async (
  owner: string,
  repo: string,
  projectTypes: ProjectType | ProjectType[] | ((getContents: GetContents) => Promise<ProjectType[]>),
  getHead = () => getDefaultBranchHead(owner, repo),
  getContents?: GetContents
): Promise<ReleaseStatus> => {
  const latestTag = await getLatestRelease(owner, repo);
  if (!latestTag) return { status: 'no-tag' };

  const result = await getHead();
  if (result.status !== 'found') return { status: result.status };

  const { baseSha, headSha, files, getCommits } = await compareCommits(
    owner, repo, `refs/tags/${latestTag}`, result.head
  );
  if (files.length === 0) return { status: 'up-to-date' };

  let rootContents: Promise<string[]> | undefined;
  const getPinnedContents = getContents ?? (() => rootContents ??= getRepoContents(owner, repo, '', headSha, result.head.treeSha));
  const resolvedTypes = typeof projectTypes === 'function' ? await projectTypes(getPinnedContents) : projectTypes;
  const types = Array.isArray(resolvedTypes) ? resolvedTypes : [resolvedTypes];
  const sourcePatterns = types.map(getSourcePatterns);
  const changedSources = files.filter((f) => sourcePatterns.some((pattern) => pattern.test(f)));

  const changedDependencyTypes = getDependencyProjectTypes(files);
  const dependencyTypes = types.filter((type) => changedDependencyTypes.includes(type));
  const { dependencyUpdates, lookupErrors } = await findDependencyUpdates(
    owner, repo, getCommits, dependencyTypes, headSha, getPinnedContents
  );

  const compareUrl = `https://github.com/${owner}/${repo}/compare/${baseSha}...${headSha}`;
  if (changedSources.length > 0 || dependencyUpdates.length > 0) {
    return {
      status: 'pending', changedSources, dependencyUpdates, compareUrl,
      ...(lookupErrors.length > 0 ? { lookupErrors } : {}),
    };
  }
  return lookupErrors.length > 0 ? { status: 'incomplete', lookupErrors } : { status: 'up-to-date' };
};

const findDependencyUpdates = async (
  owner: string,
  repo: string,
  getCommits: () => Promise<ComparedCommits>,
  types: ProjectType[],
  headSha: string,
  getContents: GetContents
): Promise<{ dependencyUpdates: DependencyUpdate[]; lookupErrors: unknown[] }> => {
  if (types.length === 0) return { dependencyUpdates: [], lookupErrors: [] };
  const { commits, lookupErrors } = await getCommits();
  const checkers = types.map((type) => ({
    type,
    check: createDependencyChecker(owner, repo, type, getContents, headSha),
  }));
  const bumps = commits.flatMap(({ sha, message }) => {
    const bump = parseBumpCommit(message);
    return bump ? [{ sha, bump }] : [];
  });
  const candidates = await Promise.all(bumps.map(async ({ sha, bump }) => {
    const results = await Promise.allSettled(checkers.map(async ({ type, check }) =>
      await check(bump.pkg) ? [type] : []
    ));
    return {
      sha, bump,
      productionTypes: results.flatMap((result) => result.status === 'fulfilled' ? result.value : []),
      productionErrors: results.flatMap((result): unknown[] => result.status === 'rejected' ? [result.reason] : []),
    };
  }));
  const lookups = await Promise.allSettled(candidates.filter(({ productionTypes }) => productionTypes.length > 0)
    .map(async ({ sha, bump, productionTypes }) => {
      return await isEligibleBump(owner, repo, sha, productionTypes) ? [bump] : [];
    }));
  return {
    dependencyUpdates: lookups.flatMap((lookup) => lookup.status === 'fulfilled' ? lookup.value : []),
    lookupErrors: [
      ...lookupErrors,
      ...new Set(candidates.flatMap(({ productionErrors }) => productionErrors)),
      ...lookups.flatMap((lookup): unknown[] => lookup.status === 'rejected' ? [lookup.reason] : []),
    ],
  };
};

const isEligibleBump = async (
  owner: string, repo: string, sha: string, productionTypes: ProjectType[]
): Promise<boolean> => limitCommitFileLookup(async () => {
  const affected = new Set<ProjectType>();
  for await (const paths of getCommitFilePages(owner, repo, sha)) {
    for (const type of getDependencyProjectTypes(paths)) {
      if (!productionTypes.includes(type)) return false;
      affected.add(type);
      if (affected.size > 1) return false;
    }
  }
  return affected.size === 1;
});
