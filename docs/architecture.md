# Architecture

This guide maps the scanner's execution flow to the source and tests. For local
setup and check commands, see [Contributing](../CONTRIBUTING.md).

## Execution flow

1. [index.ts](../src/index.ts) requires `GH_TOKEN`, initializes the shared Octokit
   client, and calls `runChecks`. An uncaught error makes the process exit with
   status 1.
2. [runner.ts](../src/runner.ts) visits the accounts in `ORGS` sequentially.
   [github.ts](../src/github.ts) lists their repositories and excludes archived,
   private, and forked repositories. Up to eight repositories are investigated
   concurrently within each account.
3. For each repository, the runner starts CI and release investigations
   concurrently. Both investigations share the runner's lazy default-branch lookup,
   which uses the branch from the repository listing when available.
4. [checker.ts](../src/checker.ts) combines commit statuses and check runs for the
   CI result. For releases, it compares the latest release tag (or fallback tag)
   with the default branch. After finding a baseline and resolving the branch, the
   release checker invokes the project-type detection callback only if the comparison
   contains changed files. The checker lazily reads and caches the root listing at
   the comparison head commit SHA for manifest detection and dependency checks.
   The runner logs `Types:` from the callback, so a successful scan can omit the
   line when there is no release or tag, no branch to compare, or no changed files.
   The checker uses the detected types to check source paths. For each dependency bump commit,
   it fetches changed paths by SHA and checks production dependencies when those
   paths identify exactly one detected ecosystem.
5. [issue.ts](../src/issue.ts) builds `PendingIssue` objects. After all accounts
   have been scanned, the runner submits the collected issues as one batch.
   The batch sorts by issue type and repository name, reads existing open issues
   by label, and skips matching titles before creating issues in `ISSUE_REPO`.

## Module boundaries

| Module | Responsibility |
|--------|----------------|
| [types.ts](../src/types.ts) | Shared result types and the `ORGS` and `ISSUE_REPO` constants. |
| [github.ts](../src/github.ts) | Octokit initialization, GitHub API calls, pagination, and complete tree comparisons when the comparison file list reaches 300 entries. |
| [runner.ts](../src/runner.ts) | Concurrency, orchestration, logging, and collection of investigation and creation failures. |
| [checker.ts](../src/checker.ts) | CI classification, dependency bump parsing, and pending release decisions. |
| [project-type.ts](../src/project-type.ts) | Root manifest detection and source path patterns; multiple ecosystems can be detected in one repository. |
| [dependency.ts](../src/dependency.ts) | Lazy, cached manifest loading and production dependency checks across detected ecosystems. |
| [issue.ts](../src/issue.ts) | Issue text, ordering, duplicate detection, and batch creation. |

Dependency parsing also uses dedicated helpers for Ruby
([ruby.ts](../src/ruby.ts), [gemfile.ts](../src/gemfile.ts), and
[gemfile-tokens.ts](../src/gemfile-tokens.ts)),
[Gradle](../src/gradle.ts), and [Swift](../src/swift.ts).
[block-comments.ts](../src/block-comments.ts) provides comment handling shared by
parsers. An unrecognized ecosystem uses `src/` as its source path and never
classifies dependency bumps as production updates.

## Failure boundaries

The runner records investigation errors without stopping other repositories or
the other investigation for the same repository. It attempts batch creation for
notifications already collected, then throws an `AggregateError` if operations
failed. Batch creation similarly attempts remaining issues after a creation
failure and reports the failures together.

The CI checker returns errors from the commit status and check run lookups
alongside the classification. If either lookup fails, the checker reports
`failure` when the available results include a failed check and `incomplete`
otherwise. The runner records the lookup errors and queues any CI notification.
When both reads succeed and no results remain after filtering, the checker
reports `no-ci`.

Errors reading releases, tags, or comparisons propagate to the runner as
investigation failures. This includes incomplete recursive trees during a
comparison. Successful release and tag reads without a baseline yield `no-tag`.

The root listing and file content helpers still fall back to an empty list or
empty string on read errors, which can affect ecosystem detection and dependency
checks. If the runner needs a separate default-branch lookup and that lookup
fails, the helper returns `null`. CI then reports `no-branch`, and the release
check reports `up-to-date` if it already found a release or tag.

## Where to start a change

- **Scan scheduling or failure isolation:** start with `runner.ts` and
  [runner.test.js](../test/runner.test.js). `runChecks` accepts dependency overrides
  for tests.
- **GitHub API behavior:** start with `github.ts` and the pagination tests under
  [test/](../test/), plus [github-failures.test.js](../test/github-failures.test.js).
  Tests mock the initialized Octokit client's methods.
- **Release detection or a new ecosystem:** start with `project-type.ts`,
  `dependency.ts`, and `checker.ts`. See
  [project-type.test.mjs](../test/project-type.test.mjs) and the ecosystem-specific
  dependency tests.
- **Notification formatting or duplicate handling:** start with `issue.ts`,
  [issue.test.js](../test/issue.test.js), and
  [issue-pagination.test.js](../test/issue-pagination.test.js).

Both test commands compile `src/` into `dist/` and run the Node.js test suite,
whose tests import the compiled modules. The [Test workflow](../.github/workflows/test.yml)
runs `npm run lint`, `npm run test:coverage` on pull requests and pushes to `main`, enforcing the
coverage thresholds defined in [package.json](../package.json). The
[weekly workflow](../.github/workflows/weekly.yml) runs `npm test` followed by
`npm run start`.
