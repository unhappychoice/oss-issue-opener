import { createIssue, listOpenIssues } from './github.js';
import type { DependencyUpdate, FailedCheck, IssueType, PendingIssue } from './types.js';
import { ISSUE_REPO } from './types.js';

const [issueOwner, issueRepo] = ISSUE_REPO.split('/') as [string, string];
const ISSUE_BODY_LIMIT = 65_536;

export const buildCIFailureIssue = (repo: string, failedChecks: FailedCheck[]): PendingIssue => {
  const intro = 'CI is failing on the default branch.\n\n**Failed checks:**\n';
  const links = `\n\n**Repository**: https://github.com/${repo}
**Actions**: https://github.com/${repo}/actions`;
  const items = failedChecks.map(formatFailedCheck);
  return {
    type: 'ci-failure',
    repo,
    title: `[CI Failure] ${repo}`,
    body: formatIssueBody(intro, items, links),
  };
};

export const buildPendingReleaseIssue = (
  repo: string,
  changedSources: string[],
  dependencyUpdates: DependencyUpdate[],
  compareUrl: string
): PendingIssue => {
  const sources = formatChangedSources(changedSources);
  const intro = `Changes since last release:\n\n${sources}`;
  const links = `\n\n**Diff**: ${compareUrl}
**Releases**: https://github.com/${repo}/releases`;
  const items = dependencyUpdates.map(({ pkg, from, to }) =>
    `- ${formatCodeSpan(pkg)} ${formatCodeSpan(from)} -> ${formatCodeSpan(to)}`);
  const heading = items.length ? `${sources ? '\n' : ''}**Dependency updates:**\n` : '';
  return {
    type: 'pending-release',
    repo,
    title: `[Pending Release] ${repo}`,
    body: formatIssueBody(intro + heading, items, links),
  };
};

const formatIssueBody = (intro: string, items: string[], links: string): string => {
  const available = ISSUE_BODY_LIMIT - intro.length - links.length;
  const list = items.join('\n');
  if (list.length <= available) return intro + list + links;

  let shown = items.length;
  let lengthWithSeparator = list.length + 1;
  let summary: string;
  do {
    shown -= 1;
    lengthWithSeparator -= items[shown].length + 1;
    summary = `- ... and ${items.length - shown} more`;
  } while (shown > 0 && lengthWithSeparator + summary.length > available);
  return intro + [...items.slice(0, shown), summary].join('\n') + links;
};

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

const formatFailedCheck = (check: FailedCheck): string => {
  const name = escapeMarkdown(check.name);
  const url = check.url ? parseHttpUrl(check.url) : null;
  return url ? `- [${name}](${url})` : `- ${name}`;
};

const formatChangedSources = (changedSources: string[]): string => {
  if (changedSources.length === 0) return '';

  const lines = ['**Source code changes:**'];
  changedSources.slice(0, 5).forEach((file) => lines.push(`- \`${escapeMarkdown(file)}\``));
  if (changedSources.length > 5) {
    lines.push(`- ... and ${changedSources.length - 5} more files`);
  }
  return lines.join('\n') + '\n';
};

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
      existing.add(issue.title);
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
