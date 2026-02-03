#!/bin/bash
set -euo pipefail

REPO="unhappychoice/oss-issue-opener"

gh label create "ci-failure" --repo "$REPO" --color "d73a4a" --description "CI build is failing" --force
gh label create "pending-release" --repo "$REPO" --color "0075ca" --description "Repository may need a new release" --force

echo "Labels created successfully!"
