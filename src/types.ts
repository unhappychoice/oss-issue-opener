export interface Repository {
  fullName: string;
  defaultBranch?: string | null;
}

export type ProjectType = 'ruby' | 'node' | 'rust' | 'kotlin' | 'go' | 'swift' | 'unknown';

export type CIStatusType = 'success' | 'failure' | 'pending' | 'no-ci' | 'no-branch' | 'incomplete';

export interface FailedCheck {
  name: string;
  url: string;
}

export interface CIStatus {
  status: CIStatusType;
  failedChecks: FailedCheck[];
  endpointErrors?: unknown[];
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

export interface DependencyUpdate {
  pkg: string;
  from: string;
  to: string;
}

export type ReleaseStatus =
  | { status: 'no-tag' }
  | { status: 'up-to-date' }
  | { status: 'pending'; changedSources: string[]; dependencyUpdates: DependencyUpdate[]; compareUrl: string };

export const ORGS = ['unhappychoice', 'irasutoya-tools', 'bitflyer-tools', 'circleci-tools'] as const;
export const ISSUE_REPO = 'unhappychoice/oss-issue-opener';
