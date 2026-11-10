#!/usr/bin/env bash
# Publish the Computer only after verification on both Linux architectures.
set -Eeuo pipefail
tag=${1:?release tag}
notes=${2:?release notes file}
shift 2
[[ $# -gt 0 && -s $notes ]]
for asset in "$@"; do [[ -s "$asset" ]] || { echo "Missing release asset: $asset" >&2; exit 1; }; done
[[ "$tag" == "$(cat scripts/mellonta/client-version)" && "$GITHUB_REF" == "refs/tags/$tag" ]]

if meta=$(gh release view "$tag" --json isDraft,targetCommitish); then
  target=$(jq -r .targetCommitish <<<"$meta")
  if [[ $(jq -r .isDraft <<<"$meta") == false ]]; then
    # GitHub releases are immutable once public. A rerun of this commit is done.
    [[ "$(gh api "repos/$GITHUB_REPOSITORY/commits/$tag" --jq .sha)" == "$GITHUB_SHA" ]]
    echo "Already published $tag."
    exit 0
  fi
  [[ "$target" == "$GITHUB_SHA" ]] || { echo "Draft $tag targets a different commit." >&2; exit 1; }
else
  gh release create "$tag" --draft --target "$GITHUB_SHA" --verify-tag \
    --title "Raft Computer $tag (Linux x86-64 and ARM64)" --notes-file "$notes"
fi
# A failed upload leaves a draft. A retry can finish it without replacing a public asset.
gh release upload "$tag" "$@" --clobber
gh release edit "$tag" --draft=false --latest=true
