import { completeIssue, createIssue, getAuthenticatedLogin, listOpenIssueDetails, updateIssueBody } from './github.js';
import type { CIStatus, DependencyUpdate, FailedCheck, IssueType, PendingIssue } from './types.js';
import { ISSUE_REPO, recoveryCheckKey } from './types.js';

const [issueOwner, issueRepo] = ISSUE_REPO.split('/') as [string, string];
const ISSUE_BODY_LIMIT = 65_536;

export const buildCIFailureIssue = (repo: string, failedChecks: FailedCheck[], scanComplete = true): PendingIssue => {
  const intro = 'CI is failing on the default branch.\n\n**Failed checks:**\n';
  const links = `\n\n**Repository**: https://github.com/${repo}
**Actions**: https://github.com/${repo}/actions`;
  const items = failedChecks.map(formatFailedCheck);
  return {
    type: 'ci-failure',
    repo,
    title: `[CI Failure] ${repo}`,
    body: formatIssueBody(intro, items, links + (scanComplete ? recoveryMarker(repo, failedChecks) : '')),
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

export const listCIAlerts = async () => listOpenIssueDetails(issueOwner, issueRepo, 'ci-failure');

export const getCIAlertRepositories = (alerts: Awaited<ReturnType<typeof listCIAlerts>>): Set<string> =>
  new Set(alerts.flatMap((alert) => {
    const recorded = recordedChecks(alert);
    return recorded ? [recorded.repo] : [];
  }));

export const closeRecoveredCIAlerts = async (
  alerts: Awaited<ReturnType<typeof listCIAlerts>>,
  recoveries: ReadonlyMap<string, NonNullable<CIStatus['recovery']>>
): Promise<void> => {
  const author = await getAuthenticatedLogin();
  const failures: Error[] = [];
  for (const alert of alerts) {
    const { number } = alert;
    const recorded = recordedChecks(alert, author);
    if (!recorded) continue;
    const { repo, checks } = recorded;
    const recovery = recoveries.get(repo);
    if (!recovery || !/^[a-f0-9]{40}$/i.test(recovery.sha)) continue;
    const passed = new Set(recovery.passedChecks.map(recoveryCheckKey));
    if (!checks.every((check) => passed.has(check))) continue;

    try {
      const url = `https://github.com/${repo}/commit/${recovery.sha}`;
      const closed = await completeIssue(issueOwner, issueRepo, number, author,
        `CI recovery verified on the default branch at [\`${recovery.sha}\`](${url}). All checks recorded in this alert passed.`,
        (issue) => {
          const current = recordedChecks(issue, author);
          return current?.repo === repo && current.checks.every((check) => passed.has(check));
        });
      if (closed) console.log(`  [closed] ${alert.title} (#${number})`);
    } catch (cause) {
      failures.push(new Error(`Failed to complete CI alert #${number}`, { cause }));
      console.error(`  [failed] Completing CI alert #${number}`, cause);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'CI alert closure failed');
};

const recordedChecks = (
  issue: Awaited<ReturnType<typeof listCIAlerts>>[number], author?: string
): { repo: string; checks: string[] } | undefined => {
  const { state, user, labels, body, pull_request } = issue;
  if (state !== 'open' || pull_request || (author !== undefined && user?.login !== author) || !labels.some((label) =>
    (typeof label === 'string' ? label : label.name) === 'ci-failure')) return undefined;

  const recorded = readRecoveryMarker(body);
  return recorded?.checks.length ? recorded : undefined;
};

const readRecoveryMarker = (body: string | null | undefined) => {
  const marker = body?.trimEnd().split('\n').at(-1)?.match(/^<!-- oss-issue-opener:ci:v1 ([\w.-]+\/[\w.-]+)(?: ([\w-]+(?: [\w-]+)*))? -->$/);
  if (!marker) return undefined;
  const [, repo, checks] = marker;
  return { repo, checks: checks?.split(' ') ?? [] };
};

const recoveryMarker = (repo: string, checks: FailedCheck[]): string => {
  const identities = checks.map(recoveryCheckKey);
  return formatRecoveryMarker(repo, identities.includes(undefined) ? [] : identities.filter((key) => key !== undefined));
};

const formatRecoveryMarker = (repo: string, checks: string[], limit = ISSUE_BODY_LIMIT / 2): string => {
  const keys = [...new Set(checks)].join(' ');
  const marker = `\n\n<!-- oss-issue-opener:ci:v1 ${repo} ${keys} -->`;
  return keys && marker.length <= limit
    ? marker : `\n\n<!-- oss-issue-opener:ci:v1 ${repo} -->`;
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

type OpenIssue = Awaited<ReturnType<typeof listCIAlerts>>[number];
type ListedIssue = Pick<OpenIssue, 'title' | 'number' | 'body'> & Partial<Pick<OpenIssue, 'user'>>;

const sortIssues = (issues: PendingIssue[]): PendingIssue[] =>
  [...issues].sort((a, b) => a.type.localeCompare(b.type) || a.repo.localeCompare(b.repo));

export const createIssuesInBatch = async (issues: PendingIssue[]): Promise<void> => {
  const sorted = sortIssues(issues);
  const existingByLabel = new Map<IssueType, ListedIssue[]>();
  const failures: Error[] = [];
  let login: ReturnType<typeof getAuthenticatedLogin> | undefined;

  for (const type of new Set(sorted.map((issue) => issue.type))) {
    try {
      const existing = await listOpenIssueDetails(issueOwner, issueRepo, type);
      existingByLabel.set(type, existing);
    } catch (cause) {
      failures.push(new Error(`Failed to look up open issues for ${type}`, { cause }));
      console.error(`  [failed] Looking up open issues for ${type}`, cause);
    }
  }

  console.log('\n=== Creating Issues (sorted by type, then repo) ===\n');

  for (const issue of sorted) {
    const existing = existingByLabel.get(issue.type);
    if (!existing) continue;
    let duplicate = existing.some(({ title }) => title === issue.title);
    try {
      const candidates = issue.type === 'ci-failure' ? existing.flatMap((alert) => {
        const recorded = readRecoveryMarker(alert.body);
        return recorded?.repo === issue.repo && (recorded.checks.length || !duplicate)
          ? [{ alert, hasChecks: recorded.checks.length > 0 }] : [];
      }) : [];
      let updated = false;
      if (candidates.length > 0) {
        const author = await (login ??= getAuthenticatedLogin());
        for (const { alert, hasChecks } of candidates) {
          if (alert.user !== undefined && alert.user?.login !== author) continue;
          duplicate = true;
          if (hasChecks && await recordSubsequentFailures(alert.number, issue, author)) {
            updated = true;
            console.log(`  [updated] ${alert.title} (#${alert.number})`);
          }
        }
      }
      if (duplicate) {
        if (!updated) console.log(`  [skip] ${issue.title} (already exists)`);
        continue;
      }

      const num = await createIssue(issueOwner, issueRepo, issue.title, issue.body, [issue.type]);
      existing.push({ title: issue.title, number: num, body: issue.body });
      console.log(`  [created] ${issue.title} (#${num})`);
    } catch (cause) {
      const failure = new Error(`Failed to ${duplicate ? 'update' : 'create'} issue: ${issue.title}`, { cause });
      failures.push(failure);
      console.error(`  [failed] ${issue.title}`, cause);
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, `Issue batch failed with ${failures.length} errors`);
  }
};

const recordSubsequentFailures = (number: number, issue: PendingIssue, author: string): Promise<boolean> =>
  updateIssueBody(issueOwner, issueRepo, number, (current) => {
    const recorded = recordedChecks(current, author);
    if (recorded?.repo !== issue.repo || !current.body) return undefined;

    const incoming = readRecoveryMarker(issue.body);
    const checks = incoming?.repo === issue.repo && incoming.checks.length
      ? [...recorded.checks, ...incoming.checks] : [];
    const body = current.body.trimEnd().split('\n').slice(0, -1).join('\n').trimEnd();
    const marker = formatRecoveryMarker(issue.repo, checks, Math.min(ISSUE_BODY_LIMIT - body.length, ISSUE_BODY_LIMIT / 2));
    const updated = body.length + marker.length <= ISSUE_BODY_LIMIT ? body + marker : body;
    return updated === current.body.trimEnd() ? undefined : updated;
  });
