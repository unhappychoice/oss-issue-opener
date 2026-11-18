import { createIssue, listOpenIssues } from './github.js';
import type { DependencyUpdate, FailedCheck, IssueType, PendingIssue } from './types.js';
import { ISSUE_REPO } from './types.js';

const [issueOwner, issueRepo] = ISSUE_REPO.split('/') as [string, string];

const escapeMarkdown = (s: string): string => s.replace(/[`[\]()]/g, '\\$&');

const formatCodeSpan = (text: string): string => {
  const length = Array.from(text.matchAll(/`+/g))
    .reduce((max, run) => Math.max(max, run[0].length + 1), 1);
  const delimiter = '`'.repeat(length);
  return `${delimiter} ${text} ${delimiter}`;
};

const parseHttpUrl = (url: string): string | null => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
};

const formatFailedChecks = (checks: FailedCheck[]): string =>
  checks
    .map((c) => {
      const name = escapeMarkdown(c.name);
      const url = c.url ? parseHttpUrl(c.url) : null;
      return url ? `- [${name}](${url})` : `- ${name}`;
    })
    .join('\n');

const formatPendingReleaseReasons = (changedSources: string[], dependencyUpdates: DependencyUpdate[]): string => {
  const reasons: string[] = [];

  if (changedSources.length > 0) {
    reasons.push('**Source code changes:**');
    changedSources.slice(0, 5).forEach((f) => reasons.push(`- \`${escapeMarkdown(f)}\``));
    if (changedSources.length > 5) {
      reasons.push(`- ... and ${changedSources.length - 5} more files`);
    }
    reasons.push('');
  }

  if (dependencyUpdates.length > 0) {
    reasons.push('**Dependency updates:**');
    dependencyUpdates.forEach(({ pkg, from, to }) => {
      reasons.push(`- ${formatCodeSpan(pkg)} ${formatCodeSpan(from)} -> ${formatCodeSpan(to)}`);
    });
  }

  return reasons.join('\n');
};

export const buildCIFailureIssue = (repo: string, failedChecks: FailedCheck[]): PendingIssue => ({
  type: 'ci-failure',
  repo,
  title: `[CI Failure] ${repo}`,
  body: `CI is failing on the default branch.

**Failed checks:**
${formatFailedChecks(failedChecks)}

**Repository**: https://github.com/${repo}
**Actions**: https://github.com/${repo}/actions`,
});

export const buildPendingReleaseIssue = (
  repo: string,
  changedSources: string[],
  dependencyUpdates: DependencyUpdate[],
  compareUrl: string
): PendingIssue => ({
  type: 'pending-release',
  repo,
  title: `[Pending Release] ${repo}`,
  body: `Changes since last release:

${formatPendingReleaseReasons(changedSources, dependencyUpdates)}

**Diff**: ${compareUrl}
**Releases**: https://github.com/${repo}/releases`,
});

const sortIssues = (issues: PendingIssue[]): PendingIssue[] =>
  [...issues].sort((a, b) => a.type.localeCompare(b.type) || a.repo.localeCompare(b.repo));

export const createIssuesInBatch = async (issues: PendingIssue[]): Promise<void> => {
  const sorted = sortIssues(issues);
  const existingByLabel = new Map<IssueType, Set<string>>();
  const failures: Error[] = [];

  for (const type of new Set(sorted.map((issue) => issue.type))) {
    try {
      const existing = await listOpenIssues(issueOwner, issueRepo, type);
      existingByLabel.set(type, new Set(existing.map((i) => i.title)));
    } catch (cause) {
      failures.push(new Error(`Failed to look up open issues for ${type}`, { cause }));
      console.error(`  [failed] Looking up open issues for ${type}`, cause);
    }
  }

  console.log('\n=== Creating Issues (sorted by type, then repo) ===\n');

  for (const issue of sorted) {
    const existing = existingByLabel.get(issue.type);
    if (!existing) continue;
    if (existing.has(issue.title)) {
      console.log(`  [skip] ${issue.title} (already exists)`);
      continue;
    }

    try {
      const num = await createIssue(issueOwner, issueRepo, issue.title, issue.body, [issue.type]);
      console.log(`  [created] ${issue.title} (#${num})`);
    } catch (cause) {
      const failure = new Error(`Failed to create issue: ${issue.title}`, { cause });
      failures.push(failure);
      console.error(`  [failed] ${issue.title}`, cause);
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, `Issue batch failed with ${failures.length} errors`);
  }
};
