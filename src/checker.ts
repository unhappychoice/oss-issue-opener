import { getCommitStatus, getCheckRuns, getDefaultBranchHead, getLatestRelease, compareCommits, getCommitFiles, getRepoContents } from './github.js';
import type { ComparedCommit } from './github.js';
import { createDependencyChecker } from './dependency.js';
import { getDependencyProjectTypes, getSourcePatterns } from './project-type.js';
import type { CIStatus, DependencyUpdate, ProjectType, ReleaseStatus } from './types.js';

// Share the lookup budget across repository scans, including paginated lookups.
const COMMIT_FILE_CONCURRENCY = 16;
const waitingLookups: (() => void)[] = [];
let activeLookups = 0;

export const checkCIStatus = async (
  owner: string,
  repo: string,
  getHead = () => getDefaultBranchHead(owner, repo)
): Promise<CIStatus> => {
  const head = await getHead().catch((error: unknown) => {
    if (error instanceof Error && 'status' in error && error.status === 404) return null;
    throw error;
  });
  if (head === undefined) return { status: 'no-branch', failedChecks: [] };
  if (head === null) return { status: 'no-ci', failedChecks: [] };

  const { sha } = head;
  const results = await Promise.allSettled([
    getCommitStatus(owner, repo, sha),
    getCheckRuns(owner, repo, sha),
  ]);

  const allStatuses = results.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
  const endpointErrors = results.flatMap((result): unknown[] => result.status === 'rejected' ? [result.reason] : []);
  const filtered = allStatuses.filter((s) => !/codecov/i.test(s.context));

  const failedChecks = filtered
    .filter((s) => s.state === 'failure' || s.state === 'error')
    .map((s) => ({ name: s.context, url: s.url }));
  const hasPending = filtered.some((s) => s.state === 'pending');

  if (endpointErrors.length > 0) {
    return { status: failedChecks.length > 0 ? 'failure' : 'incomplete', failedChecks, endpointErrors };
  }
  if (filtered.length === 0) return { status: 'no-ci', failedChecks };
  return { status: failedChecks.length > 0 ? 'failure' : hasPending ? 'pending' : 'success', failedChecks };
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

  const head = await getHead();
  if (!head) return { status: 'up-to-date' };

  const { baseSha, headSha, files, getCommits } = await compareCommits(
    owner, repo, `tags/${latestTag}`, head
  );
  if (files.length === 0) return { status: 'up-to-date' };

  let rootContents: Promise<string[]> | undefined;
  const getPinnedContents = getContents ?? (() => rootContents ??= getRepoContents(owner, repo, '', headSha, head.treeSha));
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
  getCommits: () => Promise<ComparedCommit[]>,
  types: ProjectType[],
  headSha: string,
  getContents: GetContents
): Promise<{ dependencyUpdates: DependencyUpdate[]; lookupErrors: unknown[] }> => {
  if (types.length === 0) return { dependencyUpdates: [], lookupErrors: [] };
  const commits = await getCommits();
  const checkers = types.map((type) => ({
    type,
    check: createDependencyChecker(owner, repo, type, getContents, headSha),
  }));
  const bumps = commits.flatMap(({ sha, message }) => {
    const bump = parseBumpCommit(message);
    return bump ? [{ sha, bump }] : [];
  });
  const candidates = await Promise.all(bumps.map(async ({ sha, bump }) => {
    const productionTypes = (await Promise.all(checkers.map(async ({ type, check }) =>
      await check(bump.pkg) ? [type] : []
    ))).flat();
    return { sha, bump, productionTypes };
  }));
  const lookups = await Promise.allSettled(candidates.filter(({ productionTypes }) => productionTypes.length > 0)
    .map(async ({ sha, bump, productionTypes }) => {
      const affected = getDependencyProjectTypes(await lookupCommitFiles(owner, repo, sha));
      return affected.length === 1 && productionTypes.includes(affected[0]) ? [bump] : [];
    }));
  return {
    dependencyUpdates: lookups.flatMap((lookup) => lookup.status === 'fulfilled' ? lookup.value : []),
    lookupErrors: lookups.flatMap((lookup): unknown[] => lookup.status === 'rejected' ? [lookup.reason] : []),
  };
};

const lookupCommitFiles = async (owner: string, repo: string, sha: string): Promise<string[]> => {
  if (activeLookups >= COMMIT_FILE_CONCURRENCY) {
    await new Promise<void>((resolve) => waitingLookups.push(resolve));
  } else {
    activeLookups++;
  }

  try {
    return await getCommitFiles(owner, repo, sha);
  } finally {
    const next = waitingLookups.shift();
    if (next) next();
    else activeLookups--;
  }
};
