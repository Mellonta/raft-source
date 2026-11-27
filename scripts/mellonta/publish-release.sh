#!/usr/bin/env bash
# Publish after all native Computer targets have passed verification.
set -Eeuo pipefail
tag=${1:?release tag}
notes=${2:?release notes file}
shift 2
[[ $# -gt 0 && -s $notes ]]
for asset in "$@"; do [[ -s "$asset" ]] || { echo "Missing release asset: $asset" >&2; exit 1; }; done
[[ "$tag" == "$(cat scripts/mellonta/client-version)" && "$GITHUB_REF" == "refs/tags/$tag" ]]

export GH_REPO="${GITHUB_REPOSITORY:?}"
verify_tag() {
  local sha
  sha=$(gh api "repos/$GH_REPO/commits/$tag" --jq .sha)
  [[ "$sha" == "$GITHUB_SHA" ]] || { echo "The remote tag no longer points at this build." >&2; return 1; }
}
verify_tag
if meta=$(gh release view "$tag" --json isDraft,targetCommitish); then
  if [[ $(jq -r .isDraft <<<"$meta") == false ]]; then
    echo "Already published $tag."
    exit 0
  fi
  target=$(jq -r .targetCommitish <<<"$meta")
  if [[ "$target" =~ ^[0-9a-fA-F]{40}$ && "$target" != "$GITHUB_SHA" ]]; then
    echo "Draft $tag targets a different commit." >&2
    exit 1
  fi
else
  # Git already pushed the tag. Its resolved commit identifies this release.
  gh release create "$tag" --draft --verify-tag \
    --title "Raft Computer $tag (Linux x86-64/ARM64 and Apple Silicon)" --notes-file "$notes"
fi
# A failed upload leaves a draft. A retry can finish it without replacing a public asset.
gh release upload "$tag" "$@" --clobber
verify_tag
gh release edit "$tag" --draft=false --latest=true
