# oss-issue-opener

Weekly automated issue opener for OSS maintenance tasks.

## Features

- **CI Failure Detection**: Aggregates commit statuses and checks on the default branch, excluding Codecov results
- **Pending Release Detection**: Identifies repositories with source code changes or production dependency updates since the last release
- **Batch Issue Creation**: Creates issues sorted by type, then by repository name

## Supported Languages

| Language | Dependency File | Production Detection |
|----------|----------------|---------------------|
| Ruby | `*.gemspec`, `Gemfile` | `add_dependency`, `add_runtime_dependency` |
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
   public repositories and only creates issues in `unhappychoice/oss-issue-opener`, so the broader
   `repo` scope (which also grants write access to every private repository you can reach) is not
   needed. A fine-grained PAT limited to read access on the target orgs' public repositories plus
   Issues: write on `unhappychoice/oss-issue-opener` works as well.
2. Add it as `OSS_GITHUB_TOKEN` secret in this repository

## Configuration

| Setting | Where to configure it | Behavior |
|---------|-----------------------|----------|
| `GH_TOKEN` | Environment variable | Required GitHub token used to read repositories and create issues. The process exits with status 1 when it is missing. |
| `OSS_GITHUB_TOKEN` | GitHub Actions repository secret | The weekly workflow passes this secret to the process as `GH_TOKEN`. |
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

## Local Development

For a complete first-run walkthrough, see the [getting started guide](docs/getting-started.md).

```bash
npm install
npm run build
npm test
GH_TOKEN=your_token npm run start
```

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

### Pending Release Check
1. Gets the latest non-draft release tag (falling back to the latest repository tag when no published release exists); skips repositories without a tag
2. Compares that tag with the default branch
3. Detects all ecosystems with root manifests and checks source file changes using each ecosystem's source paths (`src/` or `lib/` for Node/TypeScript). When no recognized manifest (`Cargo.toml`, `package.json`, `*.gemspec`/`Gemfile`, `build.gradle(.kts)`, `go.mod`, `Package.swift`) is found, the repository is treated as an unrecognized ecosystem: any change under `src/` counts as a source change
4. Parses dependency bump commit subjects (`Bump X from A to B` or Conventional Commits such as `chore(deps): bump X from A to B`). The commit's changed manifest and lockfile paths must identify exactly one detected ecosystem. The scanner then checks whether the bumped package is a production dependency in that ecosystem. Bumps with missing paths or paths identifying multiple ecosystems are skipped
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
