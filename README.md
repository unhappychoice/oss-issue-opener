# oss-issue-opener

Weekly automated issue opener for OSS maintenance tasks.

## Features

- **CI Failure Detection**: Checks all repositories for failing CI on default branch
- **Pending Release Detection**: Identifies repositories with production dependency updates since last release

## Target Organizations

- unhappychoice
- irasutoya-tools
- bitflyer-tools
- circleci-tools

## Setup

1. Create a GitHub Personal Access Token with `repo` scope
2. Add it as `OSS_GITHUB_TOKEN` secret in this repository
3. Run `./scripts/setup-labels.sh` to create required labels

## Manual Run

```bash
gh workflow run weekly.yml
```

## How it works

### CI Failure Check
Checks the latest workflow run on the default branch. If it failed, the repository is flagged.

### Pending Release Check
1. Gets the latest release tag
2. Compares commits since that tag
3. Filters for Dependabot commits (Bump X from A to B)
4. Checks if the bumped package is a production dependency
5. If yes, flags for potential release
