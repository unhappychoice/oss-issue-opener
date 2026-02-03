import { getCommitStatus, getCheckRuns, getDefaultBranch, getLatestRelease, compareCommits } from './github.js';
import { isProductionDependency } from './dependency.js';
import { getSourcePatterns } from './project-type.js';
import type { CIStatus, ProjectType, ReleaseStatus } from './types.js';

export const checkCIStatus = async (owner: string, repo: string): Promise<CIStatus> => {
  const defaultBranch = await getDefaultBranch(owner, repo);
  if (!defaultBranch) return { status: 'no-branch', failedChecks: [] };

  const [statuses, checkRuns] = await Promise.all([
    getCommitStatus(owner, repo, defaultBranch),
    getCheckRuns(owner, repo, defaultBranch),
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

const parseBumpCommit = (msg: string): { pkg: string; from: string; to: string } | null => {
  const match = msg.match(/^Bump ([^ ]+) from ([^ ]+) to ([^ ]+)/);
  return match ? { pkg: match[1], from: match[2], to: match[3] } : null;
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

  const prodDeps: string[] = [];
  for (const msg of commitMessages) {
    const bump = parseBumpCommit(msg);
    if (!bump) continue;
    if (await isProductionDependency(owner, repo, bump.pkg, projectType)) {
      prodDeps.push(`- ${bump.pkg} ${bump.from} -> ${bump.to}`);
    }
  }

  if (prodDeps.length > 0) {
    reasons.push('**Dependency updates:**');
    reasons.push(...prodDeps);
  }

  const compareUrl = `https://github.com/${owner}/${repo}/compare/${latestTag}...${defaultBranch}`;
  return reasons.length > 0 ? { status: 'pending', reasons: reasons.join('\n'), compareUrl } : { status: 'up-to-date' };
};
