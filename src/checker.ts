import { getCommitStatus, getCheckRuns, getDefaultBranch, getLatestRelease, compareCommits } from './github.js';
import { isProductionDependency } from './dependency.js';
import { getSourcePatterns } from './project-type.js';
import type { CIStatus, ProjectType, ReleaseStatus } from './types.js';

export const checkCIStatus = async (owner: string, repo: string): Promise<CIStatus> => {
  const defaultBranch = await getDefaultBranch(owner, repo);
  if (!defaultBranch) return 'no-branch';

  const [statuses, checkRuns] = await Promise.all([
    getCommitStatus(owner, repo, defaultBranch),
    getCheckRuns(owner, repo, defaultBranch),
  ]);

  const allStatuses = [...statuses, ...checkRuns];
  const filtered = allStatuses.filter((s) => !/codecov/i.test(s.context));
  if (filtered.length === 0) return 'no-ci';

  const hasFailure = filtered.some((s) => s.state === 'failure' || s.state === 'error');
  const hasPending = filtered.some((s) => s.state === 'pending');

  return hasFailure ? 'failure' : hasPending ? 'pending' : 'success';
};

export const checkPendingRelease = async (
  owner: string,
  repo: string,
  projectType: ProjectType
): Promise<ReleaseStatus> => {
  const latestTag = await getLatestRelease(owner, repo);
  if (!latestTag) return { status: 'no-tag' };

  const defaultBranch = await getDefaultBranch(owner, repo);
  if (!defaultBranch) return { status: 'up-to-date' };

  const { files, commitMessages } = await compareCommits(owner, repo, latestTag, defaultBranch);
  if (files.length === 0 && commitMessages.length === 0) return { status: 'up-to-date' };

  const reasons: string[] = [];

  const sourcePattern = getSourcePatterns(projectType);
  const changedSources = files.filter((f) => sourcePattern.test(f));
  if (changedSources.length > 0) {
    reasons.push('**Source code changes:**');
    changedSources.slice(0, 5).forEach((f) => reasons.push(`- \`${f}\``));
    if (changedSources.length > 5) {
      reasons.push(`- ... and ${changedSources.length - 5} more files`);
    }
    reasons.push('');
  }

  const bumpCommits = commitMessages.filter((m) => /^Bump .+ from .+ to .+/.test(m));
  const prodDeps: string[] = [];

  for (const msg of bumpCommits) {
    const match = msg.match(/^Bump ([^ ]+) from/);
    if (!match) continue;
    const pkg = match[1];
    if (await isProductionDependency(owner, repo, pkg, projectType)) {
      prodDeps.push(`- ${msg}`);
    }
  }

  if (prodDeps.length > 0) {
    reasons.push('**Production dependency updates:**');
    reasons.push(...prodDeps);
  }

  return reasons.length > 0 ? { status: 'pending', reasons: reasons.join('\n') } : { status: 'up-to-date' };
};
