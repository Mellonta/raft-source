#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage:
  prepare-computer-attachment.sh \
    --payload /secure/path/attachment.json \
    --raft-home /absolute/disposable/raft-home \
    --binary /absolute/path/to/raft-computer \
    --expected-version 1.0.31 \
    --expected-server-url https://api-aws-staging.botiverse.dev

The payload must contain one Computer attachment. This command never prints the
raw apiKey. It fails if the target server directory already exists.
USAGE
}

payload_path=""
raft_home=""
computer_binary=""
expected_version=""
expected_server_url=""

while (($#)); do
  case "$1" in
    --payload) payload_path="${2:-}"; shift 2 ;;
    --raft-home) raft_home="${2:-}"; shift 2 ;;
    --binary) computer_binary="${2:-}"; shift 2 ;;
    --expected-version) expected_version="${2:-}"; shift 2 ;;
    --expected-server-url) expected_server_url="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; usage; exit 2 ;;
  esac
done

for required_value in "$payload_path" "$raft_home" "$computer_binary" "$expected_version" "$expected_server_url"; do
  if [[ -z "$required_value" ]]; then
    usage
    exit 2
  fi
done

if [[ "$raft_home" != /* || "$computer_binary" != /* || "$payload_path" != /* ]]; then
  printf 'payload, raft-home, and binary must be absolute paths\n' >&2
  exit 2
fi
if [[ ! -f "$payload_path" || ! -x "$computer_binary" ]]; then
  printf 'payload must be a regular file and binary must be executable\n' >&2
  exit 2
fi
if ! command -v jq >/dev/null 2>&1; then
  printf 'jq is required\n' >&2
  exit 2
fi

if payload_mode="$(stat -c '%a' "$payload_path" 2>/dev/null)"; then
  :
else
  payload_mode="$(stat -f '%Lp' "$payload_path")"
fi
if (( (8#$payload_mode & 8#077) != 0 )); then
  printf 'payload must not be readable or writable by group/other (mode=%s)\n' "$payload_mode" >&2
  exit 2
fi

observed_version="$($computer_binary --version)"
if [[ "$observed_version" != "$expected_version" ]]; then
  printf 'Computer version mismatch: expected %s, observed %s\n' "$expected_version" "$observed_version" >&2
  exit 1
fi

server_id="$(jq -er '.serverId' "$payload_path")"
server_slug="$(jq -er '.serverSlug' "$payload_path")"
server_machine_id="$(jq -er '.serverMachineId' "$payload_path")"
machine_id="$(jq -er '.machineId' "$payload_path")"
payload_server_url="$(jq -er '.serverUrl' "$payload_path")"

uuid_re='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
for uuid_value in "$server_id" "$server_machine_id" "$machine_id"; do
  if [[ ! "$uuid_value" =~ $uuid_re ]]; then
    printf 'attachment contains an invalid UUID identity\n' >&2
    exit 1
  fi
done
if [[ -z "$server_slug" || "$payload_server_url" != "$expected_server_url" ]]; then
  printf 'attachment server slug or URL does not match the execution contract\n' >&2
  exit 1
fi

jq -e '
  .kind == "computer-attachment" and
  .schemaVersion == 1 and
  (.apiKey | type == "string" and startswith("sk_computer_") and length > 20) and
  (.attachedAt == null or (.attachedAt | type == "string"))
' "$payload_path" >/dev/null

computer_root="$raft_home/computer"
servers_root="$computer_root/servers"
server_dir="$servers_root/$server_id"
state_path="$server_dir/runner.state.json"

if [[ -e "$server_dir" ]]; then
  printf 'refusing to overwrite existing server state: %s\n' "$server_dir" >&2
  exit 1
fi

install -d -m 700 "$raft_home" "$computer_root" "$servers_root" "$server_dir"
jq '{
  kind: "computer-attachment",
  schemaVersion: 1,
  serverId,
  serverSlug,
  serverMachineId,
  machineId,
  apiKey,
  serverUrl,
  attachedAt: (.attachedAt // (now | todateiso8601))
}' "$payload_path" > "$state_path"
chmod 600 "$state_path"

# 1.0.31's CLI selects an attached server by slug, while its persisted state
# directory is keyed by immutable server UUID. Passing the UUID here is parsed
# as an unattached slug and must fail; preserve that compatibility boundary.
RAFT_HOME="$raft_home" "$computer_binary" start "$server_slug"

if [[ ! -f "$server_dir/managed.flag" ]]; then
  printf 'Computer start returned without creating managed.flag\n' >&2
  exit 1
fi

jq -n \
  --arg serverId "$server_id" \
  --arg serverSlug "$server_slug" \
  --arg serverMachineId "$server_machine_id" \
  --arg machineId "$machine_id" \
  --arg computerVersion "$observed_version" \
  --arg statePath "$state_path" \
  '{
    schema: "raft.task809.prepared-computer.v1",
    serverId: $serverId,
    serverSlug: $serverSlug,
    serverMachineId: $serverMachineId,
    machineId: $machineId,
    computerVersion: $computerVersion,
    statePath: $statePath,
    apiKeyPrinted: false
  }'
