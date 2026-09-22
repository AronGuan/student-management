#!/usr/bin/env bash
#
# Start both services. The API goes first: if it cannot come up (a bad DB_DSN is
# the usual reason) there is no point serving a UI whose every request will fail,
# and starting it first means the failure is reported as itself.
#
#   bash scripts/start-all.sh

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

bash "$HERE/start-backend.sh"
bash "$HERE/start-frontend.sh"

echo
echo "API  http://127.0.0.1:${BACKEND_PORT:-19080}"
echo "UI   http://127.0.0.1:${FRONTEND_PORT:-19073}"
echo "日志 $(cd "$HERE/.." && pwd)/.run/*.log"
