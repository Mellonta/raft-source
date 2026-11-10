#!/usr/bin/env bash
# Build and exercise the same release files that operators will install.
set -Eeuo pipefail
if [[ ${1:-} == --help || ${1:-} == -h ]]; then
  echo 'Usage: build-client.sh OUTPUT_DIRECTORY'
  echo 'Requires Linux x86-64 or ARM64, and the Node and pnpm versions pinned in the checkout.'
  exit 0
fi
[[ $# == 1 && $(uname -s) == Linux ]] || { echo 'Pass an output directory on a Linux build host.' >&2; exit 1; }
case $(uname -m) in
  x86_64|amd64) arch=x64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) echo 'Unsupported CPU; use Linux x86-64 or ARM64.' >&2; exit 1 ;;
esac
output=$(realpath -m -- "$1")
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
node_version=$(cat .node-version)
version=$(cat scripts/mellonta/client-version)
upstream=$(node -p "require('./packages/computer/package.json').version")
[[ "$version" == "$upstream"-mellonta.* && "$version" =~ -mellonta\.[0-9]+$ ]] || { echo "Release pin must match upstream Computer $upstream." >&2; exit 1; }
[[ "$(node --version)" == "v$node_version" && "$(node -p process.arch)" == "$arch" ]] || { echo "Use Node $node_version for $arch." >&2; exit 1; }
[[ "pnpm@$(pnpm --version)" == "$(node -p "require('./package.json').packageManager")" ]] || { echo 'Use the pinned pnpm from package.json.' >&2; exit 1; }
mkdir -p -- "$(dirname "$output")"
[[ ! -e "$output" || ( -d "$output" && -z "$(ls -A -- "$output")" ) ]] || { echo 'Output must be new or empty.' >&2; exit 1; }
staging=$(mktemp -d "$(dirname "$output")/.raft-client-build.XXXXXXXX")
trap 'rm -rf -- "$staging"' EXIT
export ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm_config_verify_deps_before_run=false
pnpm --filter @botiverse/raft-computer... install --frozen-lockfile
pnpm --filter @botiverse/raft-computer build:native --platform linux --arch "$arch" --version "$version" --node-version "$node_version" --out-dir "$staging"
node packages/computer/scripts/native/produce-manifest.mjs --dir "$staging" --version "$version" --node-version "$node_version" --required-targets "linux-$arch"
node scripts/mellonta/prepare-release.mjs "$staging"
node scripts/mellonta/smoke-install.mjs "$staging"
# Rename on the same filesystem only after the built executable passed its installation smoke.
if [[ -d "$output" ]]; then rmdir -- "$output"; fi
mv -T -- "$staging" "$output"
printf 'Verified %s for linux-%s: %s\n' "$version" "$arch" "$output"
