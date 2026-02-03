#!/bin/bash
set -euo pipefail

ORGS=("unhappychoice" "irasutoya-tools" "bitflyer-tools" "circleci-tools")
ISSUE_REPO="unhappychoice/oss-issue-opener"

check_ci_status() {
  local repo=$1
  local default_branch
  default_branch=$(gh repo view "$repo" --json defaultBranchRef -q '.defaultBranchRef.name' 2>/dev/null || echo "")
  
  if [[ -z "$default_branch" ]]; then
    return
  fi

  local status
  status=$(gh run list --repo "$repo" --branch "$default_branch" --limit 1 --json conclusion -q '.[0].conclusion' 2>/dev/null || echo "")
  
  if [[ "$status" == "failure" ]]; then
    echo "$repo"
  fi
}

check_pending_release() {
  local repo=$1
  
  local latest_tag
  latest_tag=$(gh release view --repo "$repo" --json tagName -q '.tagName' 2>/dev/null || echo "")
  
  if [[ -z "$latest_tag" ]]; then
    return
  fi

  local default_branch
  default_branch=$(gh repo view "$repo" --json defaultBranchRef -q '.defaultBranchRef.name' 2>/dev/null || echo "")

  local commits
  commits=$(gh api "repos/$repo/compare/$latest_tag...$default_branch" --jq '.commits[] | select(.commit.message | test("^Bump .+ from .+ to .+")) | .commit.message' 2>/dev/null || echo "")

  if [[ -z "$commits" ]]; then
    return
  fi

  local prod_deps=""
  while IFS= read -r msg; do
    if is_production_dependency "$repo" "$msg"; then
      prod_deps+="- $msg\n"
    fi
  done <<< "$commits"

  if [[ -n "$prod_deps" ]]; then
    echo -e "$repo\n$prod_deps"
  fi
}

is_production_dependency() {
  local repo=$1
  local commit_msg=$2
  
  # Extract package name from "Bump <package> from X to Y"
  local package
  package=$(echo "$commit_msg" | sed -n 's/^Bump \([^ ]*\) from .*/\1/p')
  
  if [[ -z "$package" ]]; then
    return 1
  fi

  # Check package.json for Node.js projects
  local pkg_json
  pkg_json=$(gh api "repos/$repo/contents/package.json" --jq '.content' 2>/dev/null | base64 -d 2>/dev/null || echo "")
  if [[ -n "$pkg_json" ]]; then
    if echo "$pkg_json" | jq -e ".dependencies[\"$package\"]" > /dev/null 2>&1; then
      return 0
    fi
    return 1
  fi

  # Check gemspec for Ruby projects
  local gemspec
  gemspec=$(gh api "repos/$repo/contents" --jq '.[] | select(.name | endswith(".gemspec")) | .name' 2>/dev/null | head -1 || echo "")
  if [[ -n "$gemspec" ]]; then
    local gemspec_content
    gemspec_content=$(gh api "repos/$repo/contents/$gemspec" --jq '.content' 2>/dev/null | base64 -d 2>/dev/null || echo "")
    if echo "$gemspec_content" | grep -q "add_dependency.*['\"]$package['\"]"; then
      return 0
    fi
    return 1
  fi

  # Default: assume it might be production dependency
  return 0
}

create_issue_if_not_exists() {
  local title=$1
  local body=$2
  local label=$3

  local existing
  existing=$(gh issue list --repo "$ISSUE_REPO" --label "$label" --state open --search "$title" --json number -q '.[0].number' 2>/dev/null || echo "")

  if [[ -z "$existing" ]]; then
    gh issue create --repo "$ISSUE_REPO" --title "$title" --body "$body" --label "$label"
    echo "Created issue: $title"
  else
    echo "Issue already exists: $title (#$existing)"
  fi
}

main() {
  echo "=== Checking CI failures ==="
  local failed_repos=()
  for org in "${ORGS[@]}"; do
    repos=$(gh repo list "$org" --limit 100 --json nameWithOwner -q '.[].nameWithOwner' 2>/dev/null || echo "")
    while IFS= read -r repo; do
      [[ -z "$repo" ]] && continue
      result=$(check_ci_status "$repo")
      if [[ -n "$result" ]]; then
        failed_repos+=("$result")
      fi
    done <<< "$repos"
  done

  if [[ ${#failed_repos[@]} -gt 0 ]]; then
    body="The following repositories have failing CI:\n\n"
    for repo in "${failed_repos[@]}"; do
      body+="- [ ] [$repo](https://github.com/$repo/actions)\n"
    done
    create_issue_if_not_exists "[Weekly] CI Failures - $(date +%Y-%m-%d)" "$body" "ci-failure"
  fi

  echo ""
  echo "=== Checking pending releases ==="
  local pending_releases=()
  for org in "${ORGS[@]}"; do
    repos=$(gh repo list "$org" --limit 100 --json nameWithOwner -q '.[].nameWithOwner' 2>/dev/null || echo "")
    while IFS= read -r repo; do
      [[ -z "$repo" ]] && continue
      result=$(check_pending_release "$repo")
      if [[ -n "$result" ]]; then
        pending_releases+=("$result")
      fi
    done <<< "$repos"
  done

  if [[ ${#pending_releases[@]} -gt 0 ]]; then
    body="The following repositories may need a release (production dependency updates since last release):\n\n"
    for item in "${pending_releases[@]}"; do
      repo=$(echo "$item" | head -1)
      deps=$(echo "$item" | tail -n +2)
      body+="### [$repo](https://github.com/$repo)\n$deps\n"
    done
    create_issue_if_not_exists "[Weekly] Pending Releases - $(date +%Y-%m-%d)" "$body" "pending-release"
  fi

  echo ""
  echo "=== Done ==="
}

main
