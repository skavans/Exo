#!/usr/bin/env bash
set -euo pipefail

STEP="${1:-patch}"

case "$STEP" in
  patch|minor|major) ;;
  *) echo "usage: npm run release -- [patch|minor|major]" >&2; exit 1 ;;
esac

if [ -n "$(git status --porcelain)" ]; then
  echo "error: working tree is not clean; commit or stash first" >&2
  exit 1
fi

npm version "$STEP" --no-git-tag-version

VERSION=$(node -p "require('./package.json').version")
TAG="v$VERSION"

npm run compile -- --production
rm -f exo-*.vsix
npx vsce package

git add package.json package-lock.json
git commit -m "release: $TAG"
git tag "$TAG"

git push origin HEAD
git push origin "$TAG"
git push github HEAD
git push github "$TAG"

if ! gh auth status >/dev/null 2>&1; then
  echo "gh is not authenticated; run: gh auth login" >&2
  exit 1
fi

GH_REPO=$(git config remote.github.url | sed -E 's#.*github\.com[:/]([^/]+/[^/]+)\.git#\1#')
gh release create "$TAG" exo-*.vsix --repo "$GH_REPO" --generate-notes

echo "✓ released $TAG (artifact: exo-$VERSION.vsix)"