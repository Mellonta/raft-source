#!/usr/bin/env bash
# CI builder: produces a relocatable userspace bundle for the native host CPU.
set -Eeuo pipefail
source_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
output_dir=$(realpath -m -- "${1:?Pass the release output directory}")
revision=$(git -C "$source_root" rev-parse HEAD)
build_root=$(mktemp -d "${RUNNER_TEMP:-/tmp}/raft-native-build.XXXXXXXX")
trap 'rm -rf -- "$build_root"' EXIT
case "$(uname -m)" in
  x86_64) target=linux-x64; conda_platform=linux-64; mamba_sha=366cd9cd8be14df1ab8ed50352a82111082a36686b2d389fdb79a92c3fafb3e3 ;;
  aarch64) target=linux-arm64; conda_platform=linux-aarch64; mamba_sha=9f93b974adcb4d166996af969b6cd371287d1a3e52733704727884d9b74cb7a7 ;;
  *) printf 'Unsupported build architecture\n' >&2; exit 1 ;;
esac
curl -fsSL --retry 3 "https://github.com/mamba-org/micromamba-releases/releases/download/2.9.0-0/micromamba-$conda_platform" -o "$build_root/micromamba"
printf '%s  %s\n' "$mamba_sha" "$build_root/micromamba" | sha256sum --check
chmod 700 "$build_root/micromamba"
export MAMBA_ROOT_PREFIX="$build_root/mamba"
runtime_prefix="$build_root/runtime"
node_version=$(cat "$source_root/.node-version")
"$build_root/micromamba" --no-rc create --yes --prefix "$runtime_prefix" --override-channels -c conda-forge \
  "nodejs=$node_version" postgresql=16.15 redis-server=7.4.7 nginx=1.30.0 \
  python=3.12 conda-pack=0.8.1 fontconfig fonts-conda-ecosystem
export PATH="$runtime_prefix/bin:$runtime_prefix/sbin:$PATH"
export ELECTRON_SKIP_BINARY_DOWNLOAD=1
npm install --global --prefix "$runtime_prefix" pnpm@10.29.3
bundle_root="$build_root/bundle"
mkdir -p "$bundle_root/app" "$output_dir"
# Only committed source is packaged, never a developer's environment or state.
git -C "$source_root" archive HEAD | tar -x -C "$bundle_root/app"
cd "$bundle_root/app"
pnpm --filter @botiverse/raft-server... --filter @botiverse/raft-web... install --frozen-lockfile
pnpm --filter @botiverse/raft-server exec vitest run src/services/mellontaPostgresReads.test.ts src/services/conversationUnread.test.ts src/services/jointMentionV6.test.ts src/services/channelService.risingwaveNoFallback.test.ts --maxWorkers=2
VITE_API_URL='' VITE_DEPLOYMENT_ENV=production VITE_COMMIT_SHA="$revision" VITE_FRONTEND_RELEASE_ID="$revision" \
  VITE_WEB_TRACE_URL='' VITE_FEEDBACK_EXPORT_URL='' pnpm --filter @botiverse/raft-web build
cp scripts/mellonta/native-runtime.py scripts/mellonta/native-nginx.conf "$bundle_root/"
cp scripts/mellonta/prod-security-headers.conf "$bundle_root/security-headers.conf"
printf '%s\n' "$revision" > "$bundle_root/revision"
"$build_root/micromamba" --no-rc list --prefix "$runtime_prefix" --explicit > "$bundle_root/runtime-packages.txt"
python - "$runtime_prefix" "$bundle_root" <<'PY'
import json, pathlib, shutil, sys
runtime, bundle = map(pathlib.Path, sys.argv[1:])
# Include the proxy's complete MIME table and the redistributed packages' notices.
mime = list(runtime.rglob('mime.types'))
if not mime: raise RuntimeError('nginx MIME table is missing')
shutil.copyfile(mime[0], bundle / 'mime.types')
records = []
for path in sorted((runtime / 'conda-meta').glob('*.json')):
    meta = json.loads(path.read_text())
    records.append({key: meta.get(key) for key in ['name', 'version', 'build', 'license', 'url', 'sha256']})
    licenses = pathlib.Path(meta['link']['source']) / 'info/licenses'
    if licenses.is_dir(): shutil.copytree(licenses, bundle / 'licenses' / path.stem)
(bundle / 'runtime-packages.json').write_text(json.dumps(records, indent=2) + '\n')
PY
conda-pack --prefix "$runtime_prefix" --output "$bundle_root/runtime.tar.gz"
tar -czf "$output_dir/raft-server-$target.tar.gz" -C "$bundle_root" .
python - "$output_dir" "$revision" "$target" <<'PY'
import hashlib, json, pathlib, sys
root, revision, target = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
bundle = root / f'raft-server-{target}.tar.gz'
sha = hashlib.sha256()
with bundle.open('rb') as stream:
    for chunk in iter(lambda: stream.read(1024**2), b''): sha.update(chunk)
(root / f'server-manifest-{target}.json').write_text(json.dumps({
    'schema': 1, 'commit': revision, 'bundle': bundle.name, 'sha256': sha.hexdigest(),
    'platform': target, 'postgres_major': 16,
}, indent=2) + '\n')
PY
