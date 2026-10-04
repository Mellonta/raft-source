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

Deployment options:
  --url URL    Public origin, required the first time (e.g. http://a.b.com:8080).
  --port PORT  Published HTTP port; default 8080.
  --bind IP    Published interface; default 0.0.0.0, or 127.0.0.1 behind a local proxy.

Source: /data/raft. Data, secrets, launchers, backups: /data/.raft-prod.
Docker must already work, with the Compose v2 plugin. Docker configuration is untouched.
HTTPS URLs require your existing TLS reverse proxy forwarding to the published port.
This creates a separate deployment; it does not migrate or stop raftdev.
EOF
}

main() {
  local command=deploy source_dir=/data/raft root=/data/.raft-prod
  local script_dir
  script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  if [[ ${1:-} == -h || ${1:-} == --help ]]; then usage; return; fi
  if [[ $# -gt 0 && $1 != --* ]]; then command=$1; shift; fi
  case "$command" in deploy|start|stop|restart|status|logs) ;; *) usage; return 1 ;; esac
  local -a options=()
  local service=server
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --url|--port|--bind)
        [[ "$command" == deploy && $# -ge 2 && $2 != --* ]] || { usage; return 1; }
        options+=("$1" "$2"); shift 2 ;;
      -h|--help) usage; return ;;
      server|web|postgres|redis)
        [[ "$command" == logs ]] || { usage; return 1; }
        service=$1; shift ;;
      *) usage; return 1 ;;
    esac
  done
  [[ $(uname -s) == Linux ]] || { echo 'Production deployment requires Linux.' >&2; return 1; }
  docker info >/dev/null
  docker compose version >/dev/null
  [[ -d /data && ! -L /data ]] && mountpoint -q /data || { echo 'Mount the data disk at /data first.' >&2; return 1; }
  umask 077
  if [[ "$command" == deploy ]]; then
    # Reuse only checkout/directory helpers; do not invoke the dev setup or its settings.
    source "$script_dir/setup-ubuntu.sh"
    local -a elevate=()
    [[ $EUID == 0 ]] || elevate=(sudo)
    local -a missing=()
    local tool
    for tool in git python3; do command -v "$tool" >/dev/null || missing+=("$tool"); done
    if [[ ${#missing[@]} -gt 0 ]]; then
      "${elevate[@]}" apt-get update
      "${elevate[@]}" apt-get install -y --no-install-recommends "${missing[@]}"
    fi
    ensure_directory "$source_dir"
    prepare_checkout "$source_dir" 0
    ensure_directory "$root"
    for tool in postgres redis uploads backups; do
      # PostgreSQL/Redis entrypoints own existing directories; no host access needed.
      [[ -d "$root/$tool" ]] || ensure_directory "$root/$tool"
    done
  fi
  [[ -d "$root" ]] || { echo 'Run deploy --url URL first.' >&2; return 1; }
  # Serialize deployment/restart operations so secrets, schema, and images agree.
  exec 9>"$root/deploy.lock"
  flock -n 9 || { echo 'Another production operation is running.' >&2; return 1; }
  if [[ "$command" == deploy ]]; then
    python3 "$source_dir/scripts/mellonta/prod-config.py" --source "$source_dir" --root "$root" "${options[@]}"
  fi
  local -a compose=(docker compose --project-name raft-prod --project-directory "$root" --env-file /dev/null -f "$root/compose.json")
  "${compose[@]}" config --quiet
  case "$command" in
    deploy)
      # Build before stopping the old application. A failed build leaves it running.
      "${compose[@]}" build server web
      "${compose[@]}" up -d --wait --wait-timeout 180 postgres redis
      "${compose[@]}" stop web server
      local backup="$root/backups/$(date -u +%Y%m%dT%H%M%SZ)-$$"
      mkdir -m 0700 "$backup"
      "${compose[@]}" exec -T postgres pg_dump -U raft -d raft -Fc > "$backup/database.dump.tmp"
      mv "$backup/database.dump.tmp" "$backup/database.dump"
      tar -C "$root" -czf "$backup/files-and-config.tar.gz" uploads settings.json server-extra.env compose.json
      echo "Backup saved: $backup"
      "${compose[@]}" run --rm --no-deps migrate
      "${compose[@]}" up -d --no-build --wait --wait-timeout 180 server web
      touch "$root/deployed"
      echo "Production is healthy. Start: bash $root/start.sh"
      echo "Logs: bash $root/raftprod logs"
      ;;
    start|restart)
      [[ -f "$root/deployed" ]] || { echo 'Complete a successful deploy first.' >&2; return 1; }
      local -a recreate=()
      if [[ "$command" == restart ]]; then
        "${compose[@]}" up -d --no-build --wait --wait-timeout 180 postgres redis
        recreate=(--no-deps --force-recreate)
      fi
      "${compose[@]}" up -d --no-build --wait --wait-timeout 180 "${recreate[@]}" server web
      ;;
    stop) "${compose[@]}" stop ;;
    status) "${compose[@]}" ps ;;
    logs) flock -u 9; "${compose[@]}" logs --tail 100 -f "$service" ;;
  esac
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
