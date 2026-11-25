#!/usr/bin/env bash
# bump, push and deploy — Northgo site map
#
# Usage (from repo root):
#   ./scripts/bump-push-deploy.sh              # patch bump, commit, push current branch
#   ./scripts/bump-push-deploy.sh minor        # minor bump
#   ./scripts/bump-push-deploy.sh major        # major bump
#   ./scripts/bump-push-deploy.sh --dry-run    # show next version + file plan, no write
#   ./scripts/bump-push-deploy.sh --no-push    # bump + commit only
#
# Deploy: GitHub Pages publishes from `main` (repo root). Pushing/merging to
# `main` triggers the built-in pages-build-deployment workflow.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

LEVEL="patch"
DRY_RUN=0
NO_PUSH=0

for arg in "$@"; do
  case "$arg" in
    patch|minor|major) LEVEL="$arg" ;;
    --dry-run) DRY_RUN=1 ;;
    --no-push) NO_PUSH=1 ;;
    -h|--help)
      sed -n '2,14p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

if [[ ! -f VERSION ]]; then
  echo "1.0.0" > VERSION
fi

OLD="$(tr -d '[:space:]' < VERSION)"
if [[ ! "$OLD" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
  echo "VERSION must be semver X.Y.Z (got: $OLD)" >&2
  exit 1
fi

MAJOR="${BASH_REMATCH[1]}"
MINOR="${BASH_REMATCH[2]}"
PATCH="${BASH_REMATCH[3]}"

case "$LEVEL" in
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  patch) PATCH=$((PATCH + 1)) ;;
esac

NEW="${MAJOR}.${MINOR}.${PATCH}"

echo "Bump: v${OLD} → v${NEW} (${LEVEL})"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "Would update: VERSION, README.md, index.html, freight-logistics.html"
  echo "Would commit and push branch: $(git rev-parse --abbrev-ref HEAD)"
  exit 0
fi

# Source of truth
printf '%s\n' "$NEW" > VERSION

# README bullet + section titles that carry the version
if [[ -f README.md ]]; then
  sed -i -E "s/^(- 版本：\`)[0-9]+\.[0-9]+\.[0-9]+(\`)/\1${NEW}\2/" README.md
  sed -i -E "s/^(## 客戶詢問管理（v)[0-9]+\.[0-9]+\.[0-9]+(）)/\1${NEW}\2/" README.md
fi

# Sitemap: hero pill + footer .version
if [[ -f index.html ]]; then
  sed -i -E "s/(<span class=\"pill\">)v[0-9]+\.[0-9]+\.[0-9]+(<\/span>)/\1v${NEW}\2/" index.html
  sed -i -E "s/(<span class=\"version\">版本 v)[0-9]+\.[0-9]+\.[0-9]+(<\/span>)/\1${NEW}\2/" index.html
fi

# Freight page footer
if [[ -f freight-logistics.html ]]; then
  sed -i -E "s/(貨運物流專頁 · v)[0-9]+\.[0-9]+\.[0-9]+/\1${NEW}/" freight-logistics.html
fi

git add VERSION README.md index.html freight-logistics.html
if git diff --cached --quiet; then
  echo "No version string changes staged (already at v${NEW}?)." >&2
  exit 1
fi

git commit -m "$(cat <<EOF
Bump site to v${NEW}

Patch version for deploy. Footer and hero version strings stay in sync with VERSION.
EOF
)"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$NO_PUSH" -eq 1 ]]; then
  echo "Committed v${NEW} on ${BRANCH} (not pushed)."
  exit 0
fi

git push -u origin "$BRANCH"
echo "Pushed ${BRANCH}. GitHub Pages deploys when this lands on main."
echo "Live site: https://ymonsterb-hash.github.io/northgo-site-map/"
