# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project has not made a tagged release yet; changes accumulate under
[Unreleased] until the first release is tagged.

## [Unreleased]

### Added

- CI failure detection: aggregates commit statuses and checks for the default branch of each
  scanned repository, excluding results whose names contain `codecov`, and opens a `ci-failure`
  issue when a failure remains.
- Pending release detection: compares the latest release tag (or fallback repository tag) with
  the default branch and opens a `pending-release` issue for source changes or production
  dependency updates, with manifest support for Ruby, Node/TypeScript, Rust, Kotlin/Java, Go, and
  Swift projects.
- Batch issue creation, sorted by notification type and then repository name, skipping
  notifications that match an existing open issue.
- Optional automatic closing of recovered CI alerts, enabled with `AUTO_CLOSE_CI_ALERTS`.
- A weekly scheduled GitHub Actions workflow (`weekly.yml`) that scans the configured
  organizations, with support for manual dispatch.
