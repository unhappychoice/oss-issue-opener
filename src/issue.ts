import { createIssue, listOpenIssues } from './github.js';
import type { IssueType, PendingIssue } from './types.js';
import { ISSUE_REPO } from './types.js';

const [issueOwner, issueRepo] = ISSUE_REPO.split('/') as [string, string];

export const buildCIFailureIssue = (repo: string): PendingIssue => ({
  type: 'ci-failure',
  repo,
  title: `[CI Failure] ${repo}`,
  body: `CI is failing on the default branch.

**Repository**: https://github.com/${repo}
**Actions**: https://github.com/${repo}/actions`,
});

export const buildPendingReleaseIssue = (repo: string, reasons: string): PendingIssue => ({
  type: 'pending-release',
  repo,
  title: `[Pending Release] ${repo}`,
  body: `Production dependency updates since last release:

${reasons}
**Repository**: https://github.com/${repo}
**Releases**: https://github.com/${repo}/releases`,
});

const sortIssues = (issues: PendingIssue[]): PendingIssue[] =>
  [...issues].sort((a, b) => a.type.localeCompare(b.type) || a.repo.localeCompare(b.repo));

export const createIssuesInBatch = async (issues: PendingIssue[]): Promise<void> => {
  const sorted = sortIssues(issues);
  const existingByLabel = new Map<IssueType, Set<string>>();

  for (const type of ['ci-failure', 'pending-release'] as IssueType[]) {
    const existing = await listOpenIssues(issueOwner, issueRepo, type);
    existingByLabel.set(type, new Set(existing.map((i) => i.title)));
  }

  console.log('\n=== Creating Issues (sorted by type, then repo) ===\n');

  for (const issue of sorted) {
    const existing = existingByLabel.get(issue.type);
    if (existing?.has(issue.title)) {
      console.log(`  [skip] ${issue.title} (already exists)`);
      continue;
    }

    const num = await createIssue(issueOwner, issueRepo, issue.title, issue.body, [issue.type]);
    console.log(`  [created] ${issue.title} (#${num})`);
  }
};
