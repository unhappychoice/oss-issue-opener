import { getCommitStatus, getCheckRuns, getBranchHead, getDefaultBranch, getLatestRelease, compareCommits, getCommitFiles, getRepoContents } from './github.js';
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
  getBranch = () => getDefaultBranch(owner, repo)
): Promise<CIStatus> => {
  const defaultBranch = await getBranch();
  if (!defaultBranch) return { status: 'no-branch', failedChecks: [] };

  const sha = await getBranchHead(owner, repo, defaultBranch);
  if (!sha) return { status: 'no-ci', failedChecks: [] };

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
  getBranch = () => getDefaultBranch(owner, repo),
  getContents?: GetContents
): Promise<ReleaseStatus> => {
  const latestTag = await getLatestRelease(owner, repo);
  if (!latestTag) return { status: 'no-tag' };

  const defaultBranch = await getBranch();
  if (!defaultBranch) return { status: 'up-to-date' };

  const { baseSha, headSha, files, commits } = await compareCommits(
    owner, repo, `tags/${latestTag}`, `heads/${defaultBranch}`
  );
  if (files.length === 0) return { status: 'up-to-date' };

  let rootContents: Promise<string[]> | undefined;
  const getPinnedContents = getContents ?? (() => rootContents ??= getRepoContents(owner, repo, '', headSha));
  const resolvedTypes = typeof projectTypes === 'function' ? await projectTypes(getPinnedContents) : projectTypes;
  const types = Array.isArray(resolvedTypes) ? resolvedTypes : [resolvedTypes];
  const sourcePatterns = types.map(getSourcePatterns);
  const changedSources = files.filter((f) => sourcePatterns.some((pattern) => pattern.test(f)));

  const changedDependencyTypes = getDependencyProjectTypes(files);
  const dependencyTypes = types.filter((type) => changedDependencyTypes.includes(type));
  const { dependencyUpdates, lookupErrors } = await findDependencyUpdates(
    owner, repo, commits, dependencyTypes, headSha, getPinnedContents
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
  commits: ComparedCommit[],
  types: ProjectType[],
  headSha: string,
  getContents: GetContents
): Promise<{ dependencyUpdates: DependencyUpdate[]; lookupErrors: unknown[] }> => {
  const dependencyUpdates: DependencyUpdate[] = [];
  const lookupErrors: unknown[] = [];
  if (types.length === 0) return { dependencyUpdates, lookupErrors };
  const checkers = new Map(types.map((type) => [type, createDependencyChecker(owner, repo, type, getContents, headSha)]));
  const bumps = commits.flatMap(({ sha, message }) => {
    const bump = parseBumpCommit(message);
    return bump ? [{ sha, bump }] : [];
  });
  const lookups = await Promise.allSettled(bumps.map(async ({ sha, bump }) => ({
    bump,
    affected: getDependencyProjectTypes(await lookupCommitFiles(owner, repo, sha)),
  })));

  for (const lookup of lookups) {
    if (lookup.status === 'rejected') {
      lookupErrors.push(lookup.reason);
      continue;
    }
    const { bump, affected } = lookup.value;
    if (affected.length !== 1) continue;
    if (await checkers.get(affected[0])?.(bump.pkg)) dependencyUpdates.push(bump);
  }
  return { dependencyUpdates, lookupErrors };
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
