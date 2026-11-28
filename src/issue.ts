import { completeIssue, createIssue, getAuthenticatedLogin, getDefaultBranchHead, listOpenIssueDetails, updateIssueBody } from './github.js';
import { checkCIStatus } from './checker.js';
import type { CIStatus, DependencyUpdate, FailedCheck, IssueType, PendingIssue } from './types.js';
import { ISSUE_REPO } from './types.js';
import { normalizeRecoveryCheckKey, recoveryCheckKey } from './recovery-key.js';

const [issueOwner, issueRepo] = ISSUE_REPO.split('/') as [string, string];
const ISSUE_BODY_LIMIT = 65_536;

const ciFailureLinks = (repo: string): string =>
  `\n\n**Repository**: https://github.com/${repo}\n**Actions**: https://github.com/${repo}/actions`;

export const buildCIFailureIssue = (repo: string, failedChecks: FailedCheck[], scanComplete = true): PendingIssue => {
  const intro = 'CI is failing on the default branch.\n\n**Failed checks:**\n';
  const links = ciFailureLinks(repo);
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

export const getCIAlertRepositories = (alerts: Awaited<ReturnType<typeof listCIAlerts>>, author: string): Set<string> =>
  new Set(alerts.flatMap((alert) => {
    const recorded = recordedChecks(alert, author);
    return recorded ? [recorded.repo] : [];
  }));

export const closeRecoveredCIAlerts = async (
  alerts: Awaited<ReturnType<typeof listCIAlerts>>,
  recoveries: ReadonlyMap<string, NonNullable<CIStatus['recovery']>>,
  author: string
): Promise<void> => {
  const failures: Error[] = [];
  for (const alert of alerts) {
    const { number } = alert;
    const recorded = recordedChecks(alert, author);
    if (!recorded) continue;
    const { repo, checks } = recorded;
    const recovery = recoveries.get(repo);
    if (!recovery || !/^[a-f0-9]{40}$/i.test(recovery.sha)) continue;
    if (!checksPassed(checks, recovery)) continue;

    try {
      const url = `https://github.com/${repo}/commit/${recovery.sha}`;
      const closed = await completeIssue(issueOwner, issueRepo, number, author,
        `CI recovery verified on the default branch at [\`${recovery.sha}\`](${url}). All checks recorded in this alert passed.`,
        async (issue) => {
          const current = recordedChecks(issue, author);
          if (current?.repo !== repo) return false;

          const [owner, name] = repo.split('/') as [string, string];
          const head = await getDefaultBranchHead(owner, name);
          if (head.status !== 'found' || head.head.sha !== recovery.sha) return false;

          const fresh = await checkCIStatus(owner, name, async () => head, true);
          if (fresh.endpointErrors?.length) throw new AggregateError(fresh.endpointErrors, 'CI recovery lookup failed');
          if (fresh.status !== 'success' || !fresh.recovery || !checksPassed(current.checks, fresh.recovery)) return false;

          const latest = await getDefaultBranchHead(owner, name);
          return latest.status === 'found' && latest.head.sha === recovery.sha;
        });
      if (closed) console.log(`  [closed] ${alert.title} (#${number})`);
    } catch (cause) {
      failures.push(new Error(`Failed to complete CI alert #${number}`, { cause }));
      console.error(`  [failed] Completing CI alert #${number}`, cause);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'CI alert closure failed');
};

const checksPassed = (checks: string[], recovery: NonNullable<CIStatus['recovery']>): boolean => {
  const passed = new Set(recovery.passedChecks.map(recoveryCheckKey));
  return checks.every((check) => passed.has(normalizeRecoveryCheckKey(check)));
};

const recordedChecks = (
  issue: Awaited<ReturnType<typeof listCIAlerts>>[number], author: string
): { repo: string; checks: string[] } | undefined => {
  const { state, user, labels, body, pull_request } = issue;
  if (state !== 'open' || pull_request || user?.login !== author || !labels.some((label) =>
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

const SUMMARY_PREFIX = '- ... and ';
const SUMMARY_SUFFIX = ' more';
const summaryLine = (hidden: number): string => `${SUMMARY_PREFIX}${hidden}${SUMMARY_SUFFIX}`;
const SUMMARY_LINE = new RegExp(`^${SUMMARY_PREFIX.replace(/\./g, '\\.')}(\\d+)${SUMMARY_SUFFIX}$`);

// Shrinks a list of lines from the end into a growing "... and N more" summary of the trailing
// bullet lines dropped, until the result fits the budget or a non-bullet line is reached.
const fitBulletList = (lines: string[], available: number, alreadyHidden = 0): string => {
  const render = (shown: number, hidden: number): string =>
    hidden > 0 ? [...lines.slice(0, shown), summaryLine(hidden)].join('\n') : lines.slice(0, shown).join('\n');

  let shown = lines.length;
  let hidden = alreadyHidden;
  let content = render(shown, hidden);
  while (content.length > available && shown > 0 && lines[shown - 1].startsWith('- ')) {
    shown -= 1;
    hidden += 1;
    content = render(shown, hidden);
  }
  return content;
};

const formatIssueBody = (intro: string, items: string[], links: string): string => {
  const available = ISSUE_BODY_LIMIT - intro.length - links.length;
  return intro + fitBulletList(items, available) + links;
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
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return /[`[\]()]/.test(parsed.href) ? null : parsed.href;
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

// A recovery candidate carries only what duplicate detection and marker updates need, so the
// source alert's body is parsed once here rather than on every notification that shares its repo.
interface RecoveryCandidate {
  title: string;
  number: number;
  user?: OpenIssue['user'];
  checks: string[];
}

const sortIssues = (issues: PendingIssue[]): PendingIssue[] =>
  [...issues].sort((a, b) => a.type.localeCompare(b.type) || a.repo.localeCompare(b.repo));

const indexRecoveryCandidate = (candidatesByRepo: Map<string, RecoveryCandidate[]>, candidate: RecoveryCandidate, repo: string): void => {
  const list = candidatesByRepo.get(repo);
  if (list) list.push(candidate); else candidatesByRepo.set(repo, [candidate]);
};

export const createIssuesInBatch = async (issues: PendingIssue[]): Promise<void> => {
  const sorted = sortIssues(issues);
  const titlesByType = new Map<IssueType, Set<string>>();
  const ciCandidatesByRepo = new Map<string, RecoveryCandidate[]>();
  const failures: Error[] = [];
  let login: ReturnType<typeof getAuthenticatedLogin> | undefined;

  for (const type of new Set(sorted.map((issue) => issue.type))) {
    try {
      const existing = await listOpenIssueDetails(issueOwner, issueRepo, type);
      titlesByType.set(type, new Set(existing.map(({ title }) => title)));
      if (type === 'ci-failure') {
        for (const alert of existing) {
          const recorded = readRecoveryMarker(alert.body);
          if (recorded) indexRecoveryCandidate(ciCandidatesByRepo, { title: alert.title, number: alert.number, user: alert.user, checks: recorded.checks }, recorded.repo);
        }
      }
    } catch (cause) {
      failures.push(new Error(`Failed to look up open issues for ${type}`, { cause }));
      console.error(`  [failed] Looking up open issues for ${type}`, cause);
    }
  }

  console.log('\n=== Creating Issues (sorted by type, then repo) ===\n');

  for (const issue of sorted) {
    const titles = titlesByType.get(issue.type);
    if (!titles) continue;
    let duplicate = titles.has(issue.title);
    try {
      const candidates = issue.type === 'ci-failure'
        ? (ciCandidatesByRepo.get(issue.repo) ?? []).filter(({ checks }) => checks.length || !duplicate)
        : [];
      let updated = false;
      if (candidates.length > 0) {
        const author = await (login ??= getAuthenticatedLogin());
        for (const { title, number, user, checks } of candidates) {
          if (user !== undefined && user?.login !== author) continue;
          duplicate = true;
          if (checks.length && await recordSubsequentFailures(number, issue, author)) {
            updated = true;
            console.log(`  [updated] ${title} (#${number})`);
          }
        }
      }
      if (duplicate) {
        if (!updated) console.log(`  [skip] ${issue.title} (already exists)`);
        continue;
      }

      const num = await createIssue(issueOwner, issueRepo, issue.title, issue.body, [issue.type]);
      titles.add(issue.title);
      if (issue.type === 'ci-failure') {
        const recorded = readRecoveryMarker(issue.body);
        if (recorded) indexRecoveryCandidate(ciCandidatesByRepo, { title: issue.title, number: num, checks: recorded.checks }, issue.repo);
      }
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

// Shrinks an already-rendered check list from the end, growing its "... and N more" summary,
// so a near-limit alert can still make room for a complete recovery marker on update.
const reclaimItemsSpace = (visible: string, available: number): string => {
  const lines = visible.split('\n');
  const summary = lines.at(-1)?.match(SUMMARY_LINE);
  const hidden = summary ? Number(summary[1]) : 0;
  if (summary) lines.pop();
  return fitBulletList(lines, available, hidden);
};

const recordSubsequentFailures = (number: number, issue: PendingIssue, author: string): Promise<boolean> =>
  updateIssueBody(issueOwner, issueRepo, number, (current) => {
    const recorded = recordedChecks(current, author);
    if (recorded?.repo !== issue.repo || !current.body) return undefined;

    const incoming = readRecoveryMarker(issue.body);
    const checks = incoming?.repo === issue.repo && incoming.checks.length
      ? [...recorded.checks, ...incoming.checks] : [];
    const marker = formatRecoveryMarker(issue.repo, checks);
    const links = ciFailureLinks(issue.repo);
    const bodyWithoutMarker = current.body.trimEnd().split('\n').slice(0, -1).join('\n').trimEnd();
    if (!bodyWithoutMarker.endsWith(links)) return undefined;

    const visible = reclaimItemsSpace(bodyWithoutMarker.slice(0, -links.length), ISSUE_BODY_LIMIT - links.length - marker.length);
    const updated = visible + links + marker;
    return updated === current.body.trimEnd() ? undefined : updated;
  });
