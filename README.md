# oss-issue-opener

[![Test](https://github.com/unhappychoice/oss-issue-opener/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/unhappychoice/oss-issue-opener/actions/workflows/test.yml?query=branch%3Amain)

Weekly automated issue opener for OSS maintenance tasks.

## Features

- **CI Failure Detection**: Aggregates commit statuses and checks on the default branch, excluding Codecov results
- **Pending Release Detection**: Identifies repositories with source code changes or production dependency updates since the last release
- **Batch Issue Creation**: Creates issues sorted by type, then by repository name

## Supported Languages

| Language | Dependency File | Production Detection |
|----------|----------------|---------------------|
| Ruby | `*.gemspec`, `Gemfile` | Gemspec `add_dependency` or `add_runtime_dependency`. If the gem is absent from the runtime dependencies in the root gemspecs, the scanner checks `gem` declarations in the root `Gemfile`, excluding declarations scoped exclusively to `:development`, `:test`, or both. For example, ungrouped `gem 'rack'` can qualify a `Gemfile.lock`-only bump for a pending-release notification, while `gem 'rack', group: :test` is excluded. |
| Node/TypeScript | `package.json` | `dependencies` |
| Rust | `Cargo.toml` | Global and target-specific `dependencies`, including individual tables |
| Kotlin/Java | `build.gradle(.kts)` | `implementation`, `api` |
| Go | `go.mod` | `require` |
| Swift | `Package.swift` | `.package()` |

Repositories without any recognized root manifest use the `unknown` fallback: only
changes under `src/` qualify for pending release detection. Dependency bump commits
are not treated as production dependency updates.

## Target Organizations

- unhappychoice
- irasutoya-tools
- bitflyer-tools
- circleci-tools

Archived, private and forked repositories are skipped.

## Setup

1. Create a GitHub Personal Access Token (Classic) with `public_repo` scope. The tool only reads
   public repositories and only writes issues in `unhappychoice/oss-issue-opener`, so the broader
   `repo` scope (which also grants write access to every private repository you can reach) is not
   needed. A fine-grained PAT limited to read access on the target orgs' public repositories plus
   Issues: write on `unhappychoice/oss-issue-opener` works as well. For either token type, the
   token owner needs push access to the destination issue repository to apply the
   `ci-failure` and `pending-release` notification labels.
2. Add it as `OSS_GITHUB_TOKEN` secret in this repository

## Configuration

| Setting | Where to configure it | Behavior |
|---------|-----------------------|----------|
| `GH_TOKEN` | Environment variable | Required GitHub token used to read repositories and create issues. The process exits with status 1 when it is missing. |
| `OSS_GITHUB_TOKEN` | GitHub Actions repository secret | The weekly workflow passes this secret to the process as `GH_TOKEN`. |
| `AUTO_CLOSE_CI_ALERTS` | Environment variable or GitHub Actions repository variable | Set to `true` to close verified CI alerts. Defaults to off. |
| `ORGS` | `src/types.ts` | Accounts to scan; defaults to the accounts listed under Target Organizations. |
| `ISSUE_REPO` | `src/types.ts` | Destination for all created issues; defaults to `unhappychoice/oss-issue-opener`. Issues are created here, not in each scanned repository. |

There are no CLI options or configuration files, and `.env` files are not loaded.
To change the scanned accounts or issue destination, edit `src/types.ts` and rebuild
with `npm run build`.

Project types are detected automatically from the root manifests listed under
Supported Languages. There is no override for an unrecognized ecosystem; its
`unknown` fallback checks `src/` changes only and ignores dependency bump commits.

Both `npm run start` and `npm run check` run the scan and create issues;
`npm run check` builds first. There is no dry-run mode. Existing open issues with
the same title and matching `ci-failure` or `pending-release` label are skipped.

## Quick Start

Install Node.js 26 and prepare a GitHub token as described in [Setup](#setup).
The scan can create issues in `unhappychoice/oss-issue-opener`. To scan your own
repositories and create issues in your own destination, update `ORGS` and
`ISSUE_REPO` in `src/types.ts` before running `npm run check`.

```bash
git clone https://github.com/unhappychoice/oss-issue-opener.git
cd oss-issue-opener
npm ci
GH_TOKEN=your_token npm run check
```

`npm run check` builds the scanner and runs it. Look for `[created]` in the
output for new notifications and `[skip]` for matching open issues. Open the
destination repository's Issues tab to see the failed checks or pending release
details. For a complete walkthrough, see the [getting started guide](docs/getting-started.md).

## Manual Run

```bash
gh workflow run weekly.yml
```

## How it works

For module responsibilities, execution flow, and contributor entry points, see
the [architecture guide](docs/architecture.md).

### CI Failure Check
Combines commit statuses and check runs for the default branch, excluding results whose names
contain `codecov` (case-insensitive). If any remaining result has a failure or error state,
creates an issue, even when other results succeeded or are pending. Otherwise, the CI status
is pending if any result is pending, successful if all results succeeded, or `no-ci` if no
results remain. The decision does not depend on workflow execution order.

If either GitHub API lookup fails, the scanner still queues a notification for
failures found on any successfully retrieved page. When the available results contain no
failure, the scanner reports `CI: incomplete`. In both cases it logs the
lookup error and exits with a nonzero status after processing the batch.

### Pending Release Check
1. Gets the latest non-draft release tag (falling back to the latest repository tag when no published release exists); skips repositories without a tag
2. Compares that tag with the default branch
3. Detects all ecosystems with root manifests and checks source file changes using each ecosystem's source paths (`src/` or `lib/` for Node/TypeScript). When no recognized manifest (`Cargo.toml`, `package.json`, `*.gemspec`/`Gemfile`, `build.gradle(.kts)`, `go.mod`, `Package.swift`) is found, the repository is treated as an unrecognized ecosystem: any change under `src/` counts as a source change
4. Parses dependency bump commit subjects (`Bump X from A to B` or Conventional Commits
   such as `chore(deps): bump X from A to B`). For each bump, the scanner checks
   production dependency membership at the comparison head in detected ecosystems with a
   changed dependency file in the release comparison. It fetches the bump commit's
   changed paths only if at least one ecosystem has a production match. For example, in
   a Node-only repository with a changed `package-lock.json`, a package listed only in
   `devDependencies` is skipped after reading `package.json`, without a commit-file
   request. For a surviving bump to count as an update, its changed manifest or lockfile
   paths must identify exactly one ecosystem, and that ecosystem must have a production
   match for the package. If a commit page omits its file list or the lookup reaches the
   3,000-file limit, the scanner records a lookup failure and still reports any
   confirmed release changes
5. Creates an issue if source files changed or production dependencies were updated, including both reasons when applicable

Source changes alone qualify: for example, a change to `src/index.ts` with the commit
`fix: handle empty input` triggers a pending release notification without any dependency updates.

Comparisons returning 300 files may omit additional changes. In that case, complete recursive
Git trees at the merge base and comparison head are compared instead. Tree retrieval failures
or truncated trees fail the release investigation rather than reporting the repository up to date.

CI and release investigations run concurrently and independently for each repository. Investigation failures are
logged with their target and cause, and scanning continues with the remaining repositories.
Detected notifications are still submitted for batch creation before failures are reported together
and the process exits with a nonzero status.

### Issue Creation
All detected issues are collected, sorted by:
1. Issue type (`ci-failure` first, then `pending-release`)
2. Repository name (alphabetically)

Then created in batch, skipping any that already exist.
Creation failures are logged per issue, and remaining issues are still attempted.
After the batch, any failures are reported together and the process exits with a nonzero status.

### Closing Recovered CI Alerts

Set `AUTO_CLOSE_CI_ALERTS=true` to enable automatic closure. For the weekly workflow,
set the `AUTO_CLOSE_CI_ALERTS` Actions repository variable to `true`.

The scanner considers open `ci-failure` issues authored by the account authenticated
with `GH_TOKEN` that carry scanner-generated recovery metadata for the scanned repository.
The existing alert must be present when the scan starts. Its recorded check runs and
commit statuses must each explicitly pass on the checked default-branch commit,
and the overall CI scan must succeed. GitHub Actions jobs must match both the
recorded job name and workflow ID. Commit statuses must match both the recorded
context and the publisher's GitHub account ID. A missing, pending, skipped, neutral, or
unreadable recorded check leaves the issue open. The scanner comments with a link
to the verified commit and closes the issue as completed.

Alerts require manual closure when the initial CI scan could not retrieve all
results, when the recovery metadata is missing, when a check run has no verified
GitHub Actions workflow ID, when a commit status has no verified publisher ID
(including older alerts that recorded only the context), or when the complete
check list cannot fit in the metadata. Linear links do not affect eligibility.
