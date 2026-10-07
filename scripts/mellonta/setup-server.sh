#!/usr/bin/env bash
# No host package installation or privilege escalation. Downloads a verified native runtime bundle.
set -Eeuo pipefail
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
exec python3 "$script_dir/native-control.py" deploy "$@"
