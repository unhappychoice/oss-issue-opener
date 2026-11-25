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

// GitHub treats commit status contexts as case-insensitive, so normalize them here and
// wherever a recovery key read from an existing alert needs to match a freshly computed one.
export const normalizeRecoveryCheckKey = (key: string): string => {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(key, 'base64url').toString());
    if (!Array.isArray(parsed) || parsed.length !== 3) return key;
    const [source, name, id]: unknown[] = parsed;
    if (source !== 'status' || typeof name !== 'string') return key;
    return Buffer.from(JSON.stringify([source, name.toLowerCase(), id])).toString('base64url');
  } catch {
    return key;
  }
};

export const recoveryCheckKey = ({ name, source, workflowId, publisherId }: CheckIdentity): string | undefined => {
  const id = source === 'check' ? workflowId : publisherId;
  if (id === undefined || !Number.isSafeInteger(id) || id <= 0) return undefined;
  return normalizeRecoveryCheckKey(Buffer.from(JSON.stringify([source, name, id])).toString('base64url'));
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
