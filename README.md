# oss-issue-opener

Weekly automated issue opener for OSS maintenance tasks.

## Features

- **CI Failure Detection**: Checks all repositories for failing CI on default branch
- **Pending Release Detection**: Identifies repositories with production dependency updates since last release
- **Per-repository Issues**: Creates separate issues for each repository

## Supported Languages

| Language | Dependency File | Production Detection |
|----------|----------------|---------------------|
| Ruby | `*.gemspec`, `Gemfile` | `add_dependency` |
| Node/TypeScript | `package.json` | `dependencies` |
| Rust | `Cargo.toml` | `[dependencies]` section |
| Kotlin/Java | `build.gradle(.kts)` | `implementation`, `api` |
| Go | `go.mod` | `require` |
| Swift | `Package.swift` | `.package()` |

## Target Organizations

- unhappychoice
- irasutoya-tools
- bitflyer-tools
- circleci-tools

## Setup

1. Create a GitHub Personal Access Token (Classic) with `repo` scope
2. Add it as `OSS_GITHUB_TOKEN` secret in this repository
3. Run `./scripts/setup-labels.sh` to create required labels

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
3. Filters for Dependabot commits (Bump X from A to B)
4. Detects project type and checks if the bumped package is a production dependency
5. If yes, creates an issue for that repository
