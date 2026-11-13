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

## Target Organizations

- unhappychoice
- irasutoya-tools
- bitflyer-tools
- circleci-tools

Archived, private and forked repositories are skipped.

## Setup

1. Create a GitHub Personal Access Token (Classic) with `repo` scope
2. Add it as `OSS_GITHUB_TOKEN` secret in this repository

## Local Development

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

### CI Failure Check
Combines commit statuses and check runs for the default branch, excluding results whose names
contain `codecov` (case-insensitive). If any remaining result has a failure or error state,
creates an issue, even when other results succeeded or are pending. Otherwise, the CI status
is pending if any result is pending, successful if all results succeeded, or `no-ci` if no
results remain. The decision does not depend on workflow execution order.

### Pending Release Check
1. Gets the latest non-draft release tag (falling back to the latest repository tag when no published release exists); skips repositories without a tag
2. Compares that tag with the default branch
3. Detects all ecosystems with root manifests and checks source file changes using each ecosystem's source paths (`src/` or `lib/` for Node/TypeScript)
4. Parses dependency bump commit subjects (`Bump X from A to B` or Conventional Commits such as `chore(deps): bump X from A to B`) and checks whether each bumped package is a production dependency in any detected ecosystem
5. Creates an issue if source files changed or production dependencies were updated, including both reasons when applicable

Source changes alone qualify: for example, a change to `src/index.ts` with the commit
`fix: handle empty input` triggers a pending release notification without any dependency updates.

CI and release investigations run independently for each repository. Investigation failures are
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
