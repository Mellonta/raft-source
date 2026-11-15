#!/usr/bin/env bash
# Build and exercise the same release files that operators will install.
set -Eeuo pipefail
if [[ ${1:-} == --help || ${1:-} == -h ]]; then
  echo 'Usage: build-client.sh OUTPUT_DIRECTORY'
  echo 'Requires Linux x86-64/ARM64 or Apple Silicon macOS, and the pinned Node and pnpm versions.'
  exit 0
fi
[[ $# == 1 && -n "$1" ]] || { echo 'Pass an output directory.' >&2; exit 1; }
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64|Linux-amd64) target=linux-x64 ;;
  Linux-aarch64|Linux-arm64) target=linux-arm64 ;;
  Darwin-arm64) target=darwin-arm64 ;;
  *) echo 'Use Linux x86-64/ARM64 or Apple Silicon macOS.' >&2; exit 1 ;;
esac
output=$(node -p 'require("node:path").resolve(process.argv[1])' -- "$1")
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
node_version=$(cat .node-version)
version=$(cat scripts/mellonta/client-version)
upstream=$(node -p "require('./packages/computer/package.json').version")
[[ "$version" == "$upstream"-mellonta.* && "$version" =~ -mellonta\.[0-9]+$ ]] || { echo "Release pin must match upstream Computer $upstream." >&2; exit 1; }
[[ "$(node --version)" == "v$node_version" && "$(node -p 'process.platform + "-" + process.arch')" == "$target" ]] || { echo "Use Node $node_version for $target." >&2; exit 1; }
[[ "pnpm@$(pnpm --version)" == "$(node -p "require('./package.json').packageManager")" ]] || { echo 'Use the pinned pnpm from package.json.' >&2; exit 1; }
mkdir -p -- "$(dirname "$output")"
[[ ! -e "$output" || ( -d "$output" && -z "$(ls -A -- "$output")" ) ]] || { echo 'Output must be new or empty.' >&2; exit 1; }
staging=$(mktemp -d "$(dirname "$output")/.raft-client-build.XXXXXXXX")
trap 'rm -rf -- "$staging"' EXIT
export ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm_config_verify_deps_before_run=false
pnpm --filter @botiverse/raft-computer... install --frozen-lockfile
pnpm --filter @botiverse/raft-computer build:native --platform "${target%-*}" --arch "${target#*-}" --version "$version" --node-version "$node_version" --out-dir "$staging"
node packages/computer/scripts/native/produce-manifest.mjs --dir "$staging" --version "$version" --node-version "$node_version" --required-targets "$target"
node scripts/mellonta/prepare-release.mjs "$staging"
node scripts/mellonta/smoke-install.mjs "$staging"
# Rename on the same filesystem only after the built executable passed its installation smoke.
node -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$staging" "$output"
printf 'Verified %s for %s: %s\n' "$version" "$target" "$output"
