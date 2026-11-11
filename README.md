# oss-issue-opener

Weekly automated issue opener for OSS maintenance tasks.

## Features

- **CI Failure Detection**: Checks all repositories for failing CI on default branch
- **Pending Release Detection**: Identifies repositories with production dependency updates since last release
- **Batch Issue Creation**: Creates issues sorted by type, then by repository name

## Supported Languages

| Language | Dependency File | Production Detection |
|----------|----------------|---------------------|
| Ruby | `*.gemspec`, `Gemfile` | `add_dependency` |
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
Checks the latest workflow run on the default branch. If it failed, creates an issue for that repository.

### Pending Release Check
1. Gets the latest release tag
2. Compares commits since that tag
3. Filters for Dependabot commits (`Bump X from A to B` or Conventional Commits such as `chore(deps): bump X from A to B`)
4. Detects project type and checks if the bumped package is a production dependency
5. If yes, creates an issue for that repository

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
