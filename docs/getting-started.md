# Getting started

This guide walks through running the OSS maintenance scanner from source and
checking its first results. It scans public, non-archived, non-fork repositories
for failing CI and changes awaiting a release, then creates notifications in a
single issue repository.

## Install from source

Use Node.js 22, matching `.node-version` and the GitHub Actions workflows, and
the npm included with Node.js.

```bash
git clone https://github.com/unhappychoice/oss-issue-opener.git
cd oss-issue-opener
npm ci
npm test
```

`npm ci` installs the locked dependencies. `npm test` compiles the TypeScript
source into `dist/` and runs the test suite; it does not run the live scanner.
To compile without running tests, use `npm run build`.

## Prepare the scan

Read the [token setup](../README.md#setup) before running against GitHub. The
scanner reads its token from `GH_TOKEN`; it does not load `.env` files.

Review `ORGS` and `ISSUE_REPO` in [src/types.ts](../src/types.ts). By default,
the scanner checks `unhappychoice`, `irasutoya-tools`, `bitflyer-tools`, and
`circleci-tools`, and creates all notifications in
`unhappychoice/oss-issue-opener`. To use your own accounts and destination,
edit those constants and run `npm run build` again. Your token must be able to
read the scanned repositories and create issues in the destination.

There are no CLI options or dry-run mode. Both `npm run start` and
`npm run check` perform a live scan and can create issues; `npm run check`
also rebuilds first.

## Run your first scan

Set `GH_TOKEN` in your shell environment, then run:

```bash
npm run start
```

The log lists each account and repository, its detected project types, CI status,
and release status. A repository can produce either or both notification types:

- `[CI Failure] owner/repo`: a failing or errored commit status or check run
  remains after excluding Codecov results.
- `[Pending Release] owner/repo`: source changes or production dependency updates
  were detected since the release tag. Repositories without a release or tag are
  skipped for this check.

Open the issues in your configured destination to inspect the failed-check links
or release comparison. The batch log reports `[created]` for new notifications
and `[skip]` for matching open issues with the corresponding `ci-failure` or
`pending-release` label. The final summary counts detected notifications,
including those skipped as duplicates; it is not a count of newly created issues.

If the process exits with an error, inspect the `[failed]` entries and the final
error. Other investigations and issue creations can still succeed during that
run, so check the destination before retrying. Without `GH_TOKEN`, the process
exits with status 1 before scanning.

## Run through GitHub Actions

For this repository's scheduled scan, configure the `OSS_GITHUB_TOKEN` repository
secret. The [weekly workflow](../.github/workflows/weekly.yml) supplies it as
`GH_TOKEN`, installs dependencies, and runs tests before scanning. It runs every
Saturday at 00:00 UTC (09:00 JST) and also supports manual dispatch:

```bash
gh workflow run weekly.yml --repo unhappychoice/oss-issue-opener
```

Manual dispatch requires GitHub CLI authentication and permission to run the
workflow. Inspect the workflow's job log and the destination issues for results.

See the [configuration reference](../README.md#configuration) for settings and
the [architecture guide](architecture.md) for module responsibilities. If a scan
fails or an expected notification is missing, see the
[troubleshooting guide](troubleshooting.md).
