#!/usr/bin/env bash
# No host package installation or privilege escalation. Enroot must already work.
set -Eeuo pipefail
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
exec python3 "$script_dir/enroot-control.py" deploy "$@"
