# FAQ and troubleshooting

## Why does the scanner say `GH_TOKEN is not set`?

For a local run, export `GH_TOKEN` in the shell that starts the scanner. The
scanner reads the process environment, so putting the token in a `.env` file
alone leaves it unset. For the weekly workflow, check that the repository secret
is named `OSS_GITHUB_TOKEN`. The workflow passes that secret as `GH_TOKEN`.
See [token setup](../README.md#setup).

## Why is there no CI failure notification?

Check the commit statuses and check runs on the scanned repository's default
branch. A failing result on a pull request branch alone does not qualify.
Results with `codecov` in their names are excluded, regardless of case.
If every remaining result is pending or successful, the scan creates no CI
failure notification.

## Why is there no pending release notification?

Check the repository's log entry. If it says `Release: no tags found`, verify
that the repository has a published release or a Git tag to compare with its
default branch. If it says `Release: up to date`, compare that baseline with
the default branch and check whether the changes match the detected ecosystem's
source paths or update a production dependency. For repositories without a
recognized root manifest, only changes under `src/` count. See the
[pending release check](../README.md#pending-release-check) for the full rules.

## Why does the summary count more notifications than were created?

The summary counts notifications detected by the scan. Check the configured
issue destination, which defaults to `unhappychoice/oss-issue-opener`, and look
for `[skip]` in the batch log. The scanner skips notifications when an open
issue already has the same title and the matching notification label.

## What should I check before retrying a failed run?

Find the first relevant `[failed]` entry in the terminal or the workflow job log
and read the error printed with it. An investigation entry identifies the
account or repository to inspect. An entry with an issue title identifies a
failed creation. If GitHub rejects issue creation, check that the token can
write issues in `ISSUE_REPO` and that the destination accepts issues.

Other investigations and issue creations can succeed during a failed run.
Check the destination before retrying. Matching open issues are skipped on the
next run.
