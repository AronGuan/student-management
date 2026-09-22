#!/usr/bin/env bash
#
# Stop the front end started by scripts/start-frontend.sh.
#
#   bash scripts/stop-frontend.sh
#
# Safe to run when nothing is running.

set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

stop_one frontend
