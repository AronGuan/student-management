#!/usr/bin/env bash
#
# Stop both services. The front end goes first so the UI stops taking requests
# before the API behind it disappears.
#
#   bash scripts/stop-all.sh
#
# Each step tolerates "not running", so this is safe to run twice or after a
# partial start.

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

bash "$HERE/stop-frontend.sh"
bash "$HERE/stop-backend.sh"
