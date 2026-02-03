#!/bin/bash
set -uo pipefail

ORGS=("unhappychoice" "irasutoya-tools" "bitflyer-tools" "circleci-tools")
ISSUE_REPO="unhappychoice/oss-issue-opener"

# Check if GH_TOKEN is set
if [[ -z "${GH_TOKEN:-}" ]]; then
  echo "❌ Error: GH_TOKEN is not set"
  echo "Please set the OSS_GITHUB_TOKEN secret in the repository settings."
  exit 1
fi

# Verify token works
if ! gh auth status &>/dev/null; then
  echo "❌ Error: GitHub authentication failed"
  echo "Please check your OSS_GITHUB_TOKEN has correct permissions."
  exit 1
fi
echo "✅ GitHub authentication successful"
echo ""

get_file_content() {
  local repo=$1
  local path=$2
  gh api "repos/$repo/contents/$path" --jq '.content' 2>/dev/null | base64 -d 2>/dev/null || echo ""
}

detect_project_type() {
  local repo=$1
  local files
  files=$(gh api "repos/$repo/contents" --jq '.[].name' 2>/dev/null || echo "")

  if echo "$files" | grep -q "Cargo.toml"; then
    echo "rust"
  elif echo "$files" | grep -q "package.json"; then
    echo "node"
  elif echo "$files" | grep -qE "\.gemspec$"; then
    echo "ruby"
  elif echo "$files" | grep -qE "build\.gradle"; then
    echo "kotlin"
  elif echo "$files" | grep -q "go.mod"; then
    echo "go"
  elif echo "$files" | grep -q "Package.swift"; then
    echo "swift"
  else
    echo "unknown"
  fi
}

is_production_dependency() {
  local repo=$1
  local package=$2
  local project_type=$3

  case "$project_type" in
    ruby)
      local gemspec
      gemspec=$(gh api "repos/$repo/contents" --jq '.[] | select(.name | endswith(".gemspec")) | .name' 2>/dev/null | head -1)
      if [[ -n "$gemspec" ]]; then
        local content
        content=$(get_file_content "$repo" "$gemspec")
        if echo "$content" | grep -qE "add_dependency.*['\"]$package['\"]"; then
          return 0
        fi
      fi
      # Also check Gemfile for non-development groups
      local gemfile
      gemfile=$(get_file_content "$repo" "Gemfile")
      if [[ -n "$gemfile" ]]; then
        if echo "$gemfile" | grep -E "^gem ['\"]$package['\"]" | grep -qvE "group.*(:development|:test)"; then
          return 0
        fi
      fi
      return 1
      ;;
    node)
      local pkg_json
      pkg_json=$(get_file_content "$repo" "package.json")
      if [[ -n "$pkg_json" ]]; then
        if echo "$pkg_json" | jq -e ".dependencies[\"$package\"]" > /dev/null 2>&1; then
          return 0
        fi
      fi
      return 1
      ;;
    rust)
      local cargo_toml
      cargo_toml=$(get_file_content "$repo" "Cargo.toml")
      if [[ -n "$cargo_toml" ]]; then
        # Check if package is in [dependencies] section (not [dev-dependencies] or [build-dependencies])
        if echo "$cargo_toml" | awk '/^\[dependencies\]/,/^\[/' | grep -qE "^$package\s*="; then
          return 0
        fi
      fi
      return 1
      ;;
    kotlin)
      local gradle_file="build.gradle"
      local content
      content=$(get_file_content "$repo" "$gradle_file")
      if [[ -z "$content" ]]; then
        content=$(get_file_content "$repo" "build.gradle.kts")
      fi
      if [[ -n "$content" ]]; then
        # implementation/api = production, testImplementation = dev
        if echo "$content" | grep -E "(implementation|api)\s*[\(\"']" | grep -q "$package"; then
          return 0
        fi
      fi
      return 1
      ;;
    go)
      local go_mod
      go_mod=$(get_file_content "$repo" "go.mod")
      if [[ -n "$go_mod" ]]; then
        if echo "$go_mod" | grep -q "$package"; then
          return 0
        fi
      fi
      return 1
      ;;
    swift)
      local pkg_swift
      pkg_swift=$(get_file_content "$repo" "Package.swift")
      if [[ -n "$pkg_swift" ]]; then
        if echo "$pkg_swift" | grep -E "\.package\(" | grep -q "$package"; then
          return 0
        fi
      fi
      return 1
      ;;
    *)
      # Unknown project type, assume production
      return 0
      ;;
  esac
}

check_ci_status() {
  local repo=$1
  local default_branch
  default_branch=$(gh repo view "$repo" --json defaultBranchRef -q '.defaultBranchRef.name' 2>/dev/null || echo "")

  if [[ -z "$default_branch" ]]; then
    echo "no-branch"
    return
  fi

  # Try GitHub Actions first
  local gha_status
  gha_status=$(gh run list --repo "$repo" --branch "$default_branch" --limit 1 --json conclusion -q '.[0].conclusion' 2>/dev/null || echo "")

  if [[ -n "$gha_status" ]]; then
    echo "$gha_status"
    return
  fi

  # Fall back to GitHub Status API (for CircleCI, etc.)
  local commit_status
  commit_status=$(gh api "repos/$repo/commits/$default_branch/status" --jq '.state' 2>/dev/null || echo "")

  if [[ -z "$commit_status" ]] || [[ "$commit_status" == "null" ]]; then
    echo "no-ci"
  else
    echo "$commit_status"
  fi
}

get_latest_tag() {
  local repo=$1
  # Try GitHub Release first, then fall back to tags
  local tag
  tag=$(gh release view --repo "$repo" --json tagName -q '.tagName' 2>/dev/null || echo "")
  if [[ -z "$tag" ]]; then
    # Fall back to latest tag via API
    tag=$(gh api "repos/$repo/tags" --jq '.[0].name' 2>/dev/null || echo "")
  fi
  echo "$tag"
}

check_pending_release() {
  local repo=$1

  local latest_tag
  latest_tag=$(get_latest_tag "$repo")

  if [[ -z "$latest_tag" ]]; then
    echo "no-tag"
    return
  fi

  local default_branch
  default_branch=$(gh repo view "$repo" --json defaultBranchRef -q '.defaultBranchRef.name' 2>/dev/null || echo "")

  local commits
  commits=$(gh api "repos/$repo/compare/$latest_tag...$default_branch" --jq '.commits[] | select(.commit.message | test("^Bump .+ from .+ to .+")) | .commit.message' 2>/dev/null || echo "")

  if [[ -z "$commits" ]]; then
    echo "up-to-date"
    return
  fi

  local project_type
  project_type=$(detect_project_type "$repo")

  local prod_deps=""
  while IFS= read -r msg; do
    [[ -z "$msg" ]] && continue
    local package
    package=$(echo "$msg" | sed -n 's/^Bump \([^ ]*\) from .*/\1/p')
    if [[ -n "$package" ]] && is_production_dependency "$repo" "$package" "$project_type"; then
      prod_deps+="- $msg"$'\n'
    fi
  done <<< "$commits"

  if [[ -n "$prod_deps" ]]; then
    echo "pending:$prod_deps"
  else
    echo "up-to-date"
  fi
}

create_issue_if_not_exists() {
  local repo=$1
  local title=$2
  local body=$3
  local label=$4

  local search_title="${title//\[/\\[}"
  search_title="${search_title//\]/\\]}"

  local existing
  existing=$(gh issue list --repo "$ISSUE_REPO" --label "$label" --state open --json title,number -q ".[] | select(.title == \"$title\") | .number" 2>/dev/null || echo "")

  if [[ -z "$existing" ]]; then
    gh issue create --repo "$ISSUE_REPO" --title "$title" --body "$body" --label "$label"
    echo "Created issue: $title"
  else
    echo "Issue already exists: $title (#$existing)"
  fi
}

log_result() {
  local icon=$1
  local message=$2
  echo "  $icon $message"
}

main() {
  echo "=== Checking all repositories ==="
  echo ""

  local total_repos=0
  local ci_failures=0
  local pending_releases=0

  for org in "${ORGS[@]}"; do
    echo "━━━ Organization: $org ━━━"
    echo ""

    local repos
    repos=$(gh repo list "$org" --limit 500 --json nameWithOwner -q '.[].nameWithOwner' 2>&1)
    if [[ $? -ne 0 ]]; then
      echo "  ⚠️  Failed to list repos: $repos"
      echo ""
      continue
    fi
    
    if [[ -z "$repos" ]]; then
      echo "  No repositories found"
      echo ""
      continue
    fi
    
    local repo_count
    repo_count=$(echo "$repos" | wc -l)
    echo "  Found $repo_count repositories"
    echo ""

    while IFS= read -r repo; do
      [[ -z "$repo" ]] && continue
      ((total_repos++))

      local repo_name="${repo#*/}"
      echo "📦 $repo_name"

      # Detect project type
      local project_type
      project_type=$(detect_project_type "$repo")
      log_result "📋" "Type: $project_type"

      # Check CI status
      local ci_status
      ci_status=$(check_ci_status "$repo")
      case "$ci_status" in
        failure)
          log_result "❌" "CI: failure"
          ((ci_failures++))
          local title="[CI Failure] $repo"
          local body="CI is failing on the default branch.

**Repository**: https://github.com/$repo
**Actions**: https://github.com/$repo/actions"
          create_issue_if_not_exists "$repo" "$title" "$body" "ci-failure"
          ;;
        success)
          log_result "✅" "CI: success"
          ;;
        no-ci)
          log_result "⚪" "CI: no workflows"
          ;;
        no-branch)
          log_result "⚪" "CI: no default branch"
          ;;
        *)
          log_result "⚪" "CI: $ci_status"
          ;;
      esac

      # Check pending release
      local release_result
      release_result=$(check_pending_release "$repo")
      
      if [[ "$release_result" == "no-tag" ]]; then
        log_result "⚪" "Release: no tags found"
      elif [[ "$release_result" == "up-to-date" ]]; then
        log_result "✅" "Release: up to date"
      elif [[ "$release_result" == pending:* ]]; then
        local pending="${release_result#pending:}"
        log_result "📦" "Release: pending (prod deps updated)"
        echo "$pending" | while IFS= read -r dep; do
          [[ -n "$dep" ]] && log_result "  " "$dep"
        done
        ((pending_releases++))
        local title="[Pending Release] $repo"
        local body="Production dependency updates since last release:

$pending
**Repository**: https://github.com/$repo
**Releases**: https://github.com/$repo/releases"
        create_issue_if_not_exists "$repo" "$title" "$body" "pending-release"
      else
        log_result "⚪" "Release: $release_result"
      fi

      echo ""
    done <<< "$repos"
  done

  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "📊 Summary"
  echo "  Total repositories: $total_repos"
  echo "  CI failures: $ci_failures"
  echo "  Pending releases: $pending_releases"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

main
