import { getCommitStatus, getCheckRuns, getBranchHead, getDefaultBranch, getLatestRelease, compareCommits, getCommitFiles } from './github.js';
import type { ComparedCommit } from './github.js';
import { createDependencyChecker } from './dependency.js';
import { getDependencyProjectTypes, getSourcePatterns } from './project-type.js';
import type { CIStatus, DependencyUpdate, ProjectType, ReleaseStatus } from './types.js';

export const checkCIStatus = async (
  owner: string,
  repo: string,
  getBranch = () => getDefaultBranch(owner, repo)
): Promise<CIStatus> => {
  const defaultBranch = await getBranch();
  if (!defaultBranch) return { status: 'no-branch', failedChecks: [] };

  const sha = await getBranchHead(owner, repo, defaultBranch);
  if (!sha) return { status: 'no-ci', failedChecks: [] };

  const [statuses, checkRuns] = await Promise.all([
    getCommitStatus(owner, repo, sha),
    getCheckRuns(owner, repo, sha),
  ]);

  const allStatuses = [...statuses, ...checkRuns];
  const filtered = allStatuses.filter((s) => !/codecov/i.test(s.context));
  if (filtered.length === 0) return { status: 'no-ci', failedChecks: [] };

  const failedChecks = filtered
    .filter((s) => s.state === 'failure' || s.state === 'error')
    .map((s) => ({ name: s.context, url: s.url }));
  const hasPending = filtered.some((s) => s.state === 'pending');

  const status = failedChecks.length > 0 ? 'failure' : hasPending ? 'pending' : 'success';
  return { status, failedChecks };
};

const parseBumpCommit = (msg: string): DependencyUpdate | null => {
  const match = msg.match(/^(?:[a-z]+(?:\([^\r\n)]+\))?!?: )?bump (\S+) from (\S+) to (\S+)/i);
  return match ? { pkg: match[1], from: match[2], to: match[3] } : null;
};

export const checkPendingRelease = async (
  owner: string,
  repo: string,
  projectTypes: ProjectType | ProjectType[] | (() => Promise<ProjectType[]>),
  getBranch = () => getDefaultBranch(owner, repo),
  getContents?: () => Promise<string[]>
): Promise<ReleaseStatus> => {
  const latestTag = await getLatestRelease(owner, repo);
  if (!latestTag) return { status: 'no-tag' };

  const resolvedTypes = typeof projectTypes === 'function' ? await projectTypes() : projectTypes;
  const defaultBranch = await getBranch();
  if (!defaultBranch) return { status: 'up-to-date' };

  const { files, commits } = await compareCommits(
    owner, repo, `tags/${latestTag}`, `heads/${defaultBranch}`
  );
  if (files.length === 0 && commits.length === 0) return { status: 'up-to-date' };

  const types = Array.isArray(resolvedTypes) ? resolvedTypes : [resolvedTypes];
  const sourcePatterns = types.map(getSourcePatterns);
  const changedSources = files.filter((f) => sourcePatterns.some((pattern) => pattern.test(f)));

  const dependencyUpdates = await findDependencyUpdates(owner, repo, commits, types, getContents);

  const compareUrl = `https://github.com/${owner}/${repo}/compare/${latestTag}...${defaultBranch}`;
  return changedSources.length > 0 || dependencyUpdates.length > 0
    ? { status: 'pending', changedSources, dependencyUpdates, compareUrl }
    : { status: 'up-to-date' };
};

const findDependencyUpdates = async (
  owner: string,
  repo: string,
  commits: ComparedCommit[],
  types: ProjectType[],
  getContents?: () => Promise<string[]>
): Promise<DependencyUpdate[]> => {
  if (types.every((type) => type === 'unknown')) return [];
  const checkers = new Map(types.map((type) => [type, createDependencyChecker(owner, repo, type, getContents)]));
  const updates: DependencyUpdate[] = [];
  for (const { sha, message } of commits) {
    const bump = parseBumpCommit(message);
    if (!bump) continue;
    const affected = getDependencyProjectTypes(await getCommitFiles(owner, repo, sha));
    if (affected.length !== 1) continue;
    if (await checkers.get(affected[0])?.(bump.pkg)) updates.push(bump);
  }
  return updates;
};
