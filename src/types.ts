export interface Repository {
  fullName: string;
  defaultBranch?: string | null;
}

export type ProjectType = 'ruby' | 'node' | 'rust' | 'kotlin' | 'go' | 'swift' | 'unknown';

export type CIStatusType = 'success' | 'failure' | 'pending' | 'no-ci' | 'no-branch' | 'incomplete';

export type CISource = 'status' | 'check';

export interface CheckIdentity {
  name: string;
  source: CISource;
  workflowId?: number;
  publisherId?: number;
}

export const recoveryCheckKey = ({ name, source, workflowId, publisherId }: CheckIdentity): string | undefined => {
  const id = source === 'check' ? workflowId : publisherId;
  if (id === undefined || !Number.isSafeInteger(id) || id <= 0) return undefined;
  return Buffer.from(JSON.stringify([source, name, id])).toString('base64url');
};

export interface FailedCheck extends CheckIdentity {
  url: string;
}

export interface CIStatus {
  status: CIStatusType;
  failedChecks: FailedCheck[];
  endpointErrors?: unknown[];
  recovery?: { sha: string; passedChecks: CheckIdentity[] };
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

export type ReleaseStatus = (
  | { status: 'no-tag' }
  | { status: 'no-branch' | 'no-head' }
  | { status: 'up-to-date' }
  | { status: 'incomplete'; lookupErrors: unknown[] }
  | { status: 'pending'; changedSources: string[]; dependencyUpdates: DependencyUpdate[]; compareUrl: string }
) & { lookupErrors?: unknown[] };

export const ORGS = ['unhappychoice', 'irasutoya-tools', 'bitflyer-tools', 'circleci-tools'] as const;
export const ISSUE_REPO = 'unhappychoice/oss-issue-opener';
