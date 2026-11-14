#!/usr/bin/env bash
# Production deployment on the existing Docker daemon; no host Node required.
set -Eeuo pipefail

usage() {
  cat <<'EOF'
Usage: bash scripts/mellonta/deploy-prod.sh [COMMAND] [OPTIONS]

Commands: deploy (default), start, stop, restart, status, logs [SERVICE]
  deploy    Build images, back up existing data, migrate schema, start and check health.
  start     Start previously deployed images; also used after a reboot.
  restart   Recreate app containers, reloading server-extra.env, without rebuilding.
  stop      Stop containers, keeping all data.

All commands accept --state-dir DIR. It is the directory for databases, uploads,
settings, backups and launchers. Default: RAFT_PROD_STATE_DIR, then /data/.raft-prod
on Linux or ~/.raft-prod on macOS.

Deployment options:
  --url URL    Public origin, required the first time (e.g. http://a.b.com:8080).
  --port PORT  Published HTTP port; defaults to an explicit HTTP --url port, otherwise 8080 on first setup.
  --bind IP    Published interface; default 0.0.0.0, or 127.0.0.1 behind a local proxy.

Images are built from the checkout containing this script.
Docker must already work, with the Compose v2 plugin. Docker configuration is untouched.
HTTPS URLs require your existing TLS reverse proxy forwarding to the published port.
This creates a separate deployment; it does not migrate or stop raftdev.
EOF
}

as_root() {
  if (( EUID == 0 )); then "$@"; else sudo "$@"; fi
}

main() (
  local command='' root=${RAFT_PROD_STATE_DIR:-} host_os
  local script_dir source_dir
  script_dir=$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
  source_dir=$(cd -- "$script_dir/../.." && pwd -P)
  local -a options=()
  local service=server
  while [[ $# -gt 0 ]]; do
    case "$1" in
      deploy|start|stop|restart|status|logs)
        [[ -z "$command" ]] || { usage; return 1; }
        command=$1; shift ;;
      --state-dir)
        [[ $# -ge 2 && -n "$2" && $2 != --* ]] || { echo '--state-dir requires a directory.' >&2; return 1; }
        root=$2; shift 2 ;;
      --url|--port|--bind)
        [[ $# -ge 2 && $2 != --* ]] || { usage; return 1; }
        options+=("$1" "$2"); shift 2 ;;
      -h|--help) usage; return ;;
      server|web|postgres|redis|risingwave)
        [[ "$command" == logs ]] || { usage; return 1; }
        service=$1; shift ;;
      *) usage; return 1 ;;
    esac
  done
  command=${command:-deploy}
  [[ "$command" == deploy || ${#options[@]} -eq 0 ]] || { usage; return 1; }
  host_os=$(uname -s)
  case "$host_os" in
    Linux) root=${root:-/data/.raft-prod} ;;
    Darwin) root=${root:-"$HOME/.raft-prod"} ;;
    *) echo 'Production deployment requires Linux or macOS.' >&2; return 1 ;;
  esac
  docker info >/dev/null
  docker compose version >/dev/null
  umask 077
  if [[ "$command" == deploy ]]; then
    [[ -e "$source_dir/.git" && -f "$script_dir/prod.Dockerfile" ]] || {
      echo 'Run deploy-prod.sh from the Raft source checkout.' >&2; return 1;
    }
    local -a missing=()
    local tool
    for tool in git python3; do command -v "$tool" >/dev/null || missing+=("$tool"); done
    if [[ ${#missing[@]} -gt 0 ]]; then
      [[ "$host_os" == Linux ]] && command -v apt-get >/dev/null || { printf 'Install the missing tools: %s\n' "${missing[*]}" >&2; return 1; }
      as_root apt-get update
      as_root apt-get install -y --no-install-recommends "${missing[@]}"
    fi
  fi
  root=$(python3 -c 'from pathlib import Path; import sys; print(Path(sys.argv[1]).resolve())' "$root")
  case "$root" in
    /|"$source_dir"|"$source_dir"/*) echo 'Choose a state directory outside the source checkout.' >&2; return 1 ;;
  esac
  if [[ "$command" == deploy ]]; then
    if [[ ! -d "$root" ]] && ! mkdir -p -- "$root" 2>/dev/null; then
      as_root install -d -m 0700 -o "$(id -u)" -g "$(id -g)" "$root"
    fi
    [[ -w "$root" && -x "$root" ]] || { printf 'Deployment account cannot write to %s\n' "$root" >&2; return 1; }
    mkdir -p -- "$root"/{postgres,redis,risingwave,uploads,backups}
  fi
  if [[ "$command" != deploy && ! -f "$root/compose.json" ]]; then
    printf 'No production deployment in %s. Run deploy --url URL first.\n' "$root" >&2
    return 1
  fi
  # Status and logs must stay available while another terminal is deploying.
  if [[ "$command" != status && "$command" != logs ]]; then
    exec 9>"$root/deploy.lock"
    # The shell keeps fd 9 open, so the lock outlives the Python process.
    python3 -c 'import fcntl, sys
try:
    fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    sys.exit("Another production operation is running.")'
  fi
  # Use the project name recorded in this directory's Compose file.
  unset COMPOSE_PROJECT_NAME
  local -a compose_cmd=(docker compose --project-directory "$root" --env-file /dev/null)
  local -a compose=("${compose_cmd[@]}" -f "$root/compose.json")
  if [[ "$command" == deploy ]]; then
    local staging
    staging=$(mktemp -d "$root/.deploy.XXXXXXXX")
    trap 'rm -rf -- "$staging"' EXIT
    options+=(--source "$source_dir" --root "$root" --output "$staging")
    python3 "$script_dir/prod-config.py" "${options[@]}"
    python3 - "$staging/settings.json" <<'PY'
import json, sys
settings = json.load(open(sys.argv[1]))
print('Portal URL: ' + settings['public_url'], flush=True)
print(f"HTTP listener: {settings['bind']}:{settings['port']}", flush=True)
PY
    local -a proposed=("${compose_cmd[@]}" -f "$staging/compose.json")
    "${proposed[@]}" config --quiet
    "${proposed[@]}" build server web
    local rw_image
    rw_image=$("${proposed[@]}" config --images risingwave)
    if ! docker image inspect "$rw_image" >/dev/null 2>&1; then "${proposed[@]}" pull risingwave; fi
    if [[ -f "$root/compose.json" ]]; then
      # Use the running release and its credentials until the backup is complete.
      "${compose[@]}" up -d --no-recreate --wait --wait-timeout 180 postgres
      "${compose[@]}" stop web server
      local backup="$root/backups/$(date -u +%Y%m%dT%H%M%SZ)-$$"
      mkdir -m 0700 "$backup"
      "${compose[@]}" exec -T postgres pg_dump -U raft -d raft -Fc > "$backup/database.dump.tmp"
      mv "$backup/database.dump.tmp" "$backup/database.dump"
      tar -czf "$backup/files-and-config.tar.gz.tmp" -C "$root" uploads server-extra.env settings.json compose.json
      mv "$backup/files-and-config.tar.gz.tmp" "$backup/files-and-config.tar.gz"
      echo "Backup saved: $backup"
    fi
    rm -f -- "$root/deployed"
    # Persist credentials before first initializing PostgreSQL.
    mv -- "$staging"/{settings.json,compose.json,start.sh,raftprod} "$root/"
  fi
  case "$command" in
    deploy)
      local revision
      revision=$(git -C "$source_dir" rev-parse HEAD)
      "${compose[@]}" up -d --wait --wait-timeout 180 postgres redis risingwave
      "${compose[@]}" run --rm --no-deps migrate
      "${compose[@]}" run --rm --no-deps rw-bootstrap
      "${compose[@]}" up -d --no-build --wait --wait-timeout 180 server web
      python3 "$source_dir/scripts/mellonta/prod-verify.py" --settings "$root/settings.json" --revision "$revision"
      touch "$root/deployed"
      printf 'API is healthy and the current frontend is served. Start: bash %q\n' "$root/start.sh"
      printf 'Logs: bash %q logs\n' "$root/raftprod"
      ;;
    start|restart)
      [[ -f "$root/deployed" ]] || { echo 'Complete a successful deploy first.' >&2; return 1; }
      local -a start_args=(up -d --no-build --wait --wait-timeout 180)
      if [[ "$command" == restart ]]; then
        "${compose[@]}" "${start_args[@]}" postgres redis risingwave
        start_args+=(--no-deps --force-recreate)
      fi
      "${compose[@]}" "${start_args[@]}" server web
      ;;
    stop) "${compose[@]}" stop ;;
    status) "${compose[@]}" ps ;;
    logs) "${compose[@]}" logs --tail 100 -f "$service" ;;
  esac
)

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
