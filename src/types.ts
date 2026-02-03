export type ProjectType = 'ruby' | 'node' | 'rust' | 'kotlin' | 'go' | 'swift' | 'unknown';

export type CIStatusType = 'success' | 'failure' | 'pending' | 'no-ci' | 'no-branch';

export interface FailedCheck {
  name: string;
  url: string;
}

export interface CIStatus {
  status: CIStatusType;
  failedChecks: FailedCheck[];
}

export type IssueType = 'ci-failure' | 'pending-release';

export interface PendingIssue {
  type: IssueType;
  repo: string;
  title: string;
  body: string;
}

export interface CheckResult {
  repo: string;
  projectType: ProjectType;
  ciStatus: CIStatus;
  releaseStatus: ReleaseStatus;
}

export type ReleaseStatus =
  | { status: 'no-tag' }
  | { status: 'up-to-date' }
  | { status: 'pending'; reasons: string; compareUrl: string };

export const ORGS = ['unhappychoice', 'irasutoya-tools', 'bitflyer-tools', 'circleci-tools'] as const;
export const ISSUE_REPO = 'unhappychoice/oss-issue-opener';

export const LABELS: Record<IssueType, { color: string; description: string }> = {
  'ci-failure': { color: 'd73a4a', description: 'CI build is failing' },
  'pending-release': { color: '0075ca', description: 'Repository may need a new release' },
};
