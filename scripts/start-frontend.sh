#!/usr/bin/env bash
#
# Serve the built SPA in the background, with /api proxied to the API.
#
#   bash scripts/start-frontend.sh              # build, then serve
#   SKIP_BUILD=1 bash scripts/start-frontend.sh # serve whatever is in dist/
#
# `vite preview`, not `vite dev`: it serves frontend/dist over HTTP with the
# same proxy config, so what runs here is the artifact that gets reviewed - not
# a dev server that compiles on the fly.
#
# The proxy is not optional. The browser only ever calls /api on its own origin
# (lib/api.ts: API_BASE defaults to "/api/v1") because ae_token is an httpOnly
# cookie. Without preview.proxy in vite.config.ts the request would hit the
# preview server, fall through to the SPA fallback, and be answered with
# index.html and a 200 - the API looks broken in a way that points at nothing.
#
# Writes: .run/frontend.pid   .run/frontend.log

set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

if alive frontend; then
  echo "[frontend] already running (pid $(current_pid frontend)) on :$FRONTEND_PORT"
  exit 0
fi

refuse_if_taken frontend "$FRONTEND_PORT"

cd "$REPO_ROOT/frontend"

if [ ! -d node_modules ]; then
  echo "[frontend] node_modules missing - running npm ci"
  npm ci
fi

if [ "${SKIP_BUILD:-0}" = "1" ]; then
  echo "[frontend] SKIP_BUILD=1 - serving the existing dist/ as is"
else
  echo "[frontend] building (tsc -b && vite build)..."
  npm run build
fi

if [ ! -f dist/index.html ]; then
  echo "[frontend] dist/index.html is missing - the build did not produce an artifact." >&2
  exit 1
fi

banner "starting frontend on :$FRONTEND_PORT" >>"$(logfile frontend)"

# Call the vite binary directly instead of `npm run preview`.
#
# `npm run` forks a child, so `$!` would be npm's pid, not the server's: stopping
# the recorded pid would kill npm and leave the actual vite process orphaned and
# still holding the port. Invoking node_modules/.bin/vite puts the server in the
# pid we record - and since that file is a shebang script, the kernel execs node
# with the same pid, so there is no wrapper left to leak.
#
# FRONTEND_PORT / BACKEND_PORT are exported by lib.sh; vite.config.ts reads both,
# so the listening port and the proxy target come from one place.
nohup "$REPO_ROOT/frontend/node_modules/.bin/vite" preview >>"$(logfile frontend)" 2>&1 &
echo $! >"$(pidfile frontend)"

pid="$(current_pid frontend)"
if wait_http "http://127.0.0.1:$FRONTEND_PORT/" 20; then
  echo "[frontend] up on :$FRONTEND_PORT (pid $pid)"
  exit 0
fi

echo "[frontend] pid $pid did NOT answer on :$FRONTEND_PORT within 20s." >&2
echo "           Last 20 log lines ($(logfile frontend)):" >&2
tail -n 20 "$(logfile frontend)" >&2 || true
exit 1
