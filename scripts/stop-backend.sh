#!/usr/bin/env bash
#
# Stop the API started by scripts/start-backend.sh.
#
#   bash scripts/stop-backend.sh
#
# SIGTERM first, because the server closes its connection pool on it; SIGKILL
# only if it ignores the signal for 15s. Safe to run when nothing is running.

set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

stop_one backend
