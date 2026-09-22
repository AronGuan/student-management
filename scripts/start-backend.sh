#!/usr/bin/env bash
#
# Start the API in the background.
#
#   bash scripts/start-backend.sh              # build, then start
#   SKIP_BUILD=1 bash scripts/start-backend.sh # start the existing .run/ae-api
#
# Always rebuilds before starting. That is on purpose: the usual way this script
# gets called is "git pull && restart", and starting the previously compiled
# binary would serve the old code with no error anywhere - the exact failure
# this repo has hit repeatedly on the front end (Vite HMR hides it) and on the
# back end (a running process never picks up new source).
#
# SKIP_BUILD=1 exists for servers without a Go toolchain: cross-compile on the
# dev machine (GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build), copy the binary
# to .run/ae-api, then start with SKIP_BUILD=1. Without this, "no Go on the box"
# and "the build is broken" would look identical - a failed script with no
# obvious reason to use the working binary sitting right there.
#
# Writes: .run/backend.pid   .run/backend.log   .run/ae-api (the binary)

set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

BIN="$RUN_DIR/ae-api"

if alive backend; then
  echo "[backend] already running (pid $(current_pid backend)) on :$BACKEND_PORT"
  exit 0
fi

refuse_if_taken backend "$BACKEND_PORT"

if [ "${SKIP_BUILD:-0}" = "1" ]; then
  echo "[backend] SKIP_BUILD=1 - starting the existing binary"
  if [ ! -x "$BIN" ]; then
    echo "[backend] $BIN is missing or not executable - nothing to start." >&2
    echo "           Drop a cross-compiled binary there, or run without SKIP_BUILD=1 to build it here." >&2
    exit 1
  fi
else
  echo "[backend] building (CGO_ENABLED=0)..."
  ( cd "$REPO_ROOT/backend" && CGO_ENABLED=0 go build -o "$BIN" ./cmd/server )
fi

banner "starting backend on :$BACKEND_PORT" >>"$(logfile backend)"

# Run from backend/ so config.Load() finds the repo-root .env through its
# "../.env" fallback (godotenv.Load() only reads the cwd).
cd "$REPO_ROOT/backend"
nohup "$BIN" >>"$(logfile backend)" 2>&1 &
echo $! >"$(pidfile backend)"

pid="$(current_pid backend)"
if wait_http "http://127.0.0.1:$BACKEND_PORT/healthz" 15; then
  echo "[backend] up on :$BACKEND_PORT (pid $pid)"
  exit 0
fi

echo "[backend] pid $pid did NOT answer /healthz within 15s." >&2
# "did not answer" alone reads as a crash in both of these cases, and they have
# completely different causes. The alive-but-silent one is the confusing one: a
# DB_DSN whose port is DROPPED (rather than refused) makes the connect BLOCK
# instead of fail, and the go-sql-driver has no connect timeout unless the DSN
# sets one - so the process sits there with an empty log for ~2 minutes, which
# looks identical to "the binary didn't run".
if alive backend; then
  echo "          The process is STILL RUNNING, so it has not crashed: it is blocked" >&2
  echo "          before r.Run(). The first network I/O in that window is the database" >&2
  echo "          (repo.EnsureDatabase), and a dropped SYN hangs rather than errors." >&2
  echo "          Re-read the log in ~60s - the driver will eventually time out:" >&2
  echo "            tail -n 40 $(logfile backend)" >&2
  echo "          Reachability, which takes 5s instead of 2 minutes:" >&2
  echo "            timeout 5 bash -c '</dev/tcp/<db-host>/3306' && echo ok || echo blocked" >&2
else
  echo "          The process is GONE, so it crashed rather than hung." >&2
fi
echo "          Last 20 log lines ($(logfile backend)):" >&2
tail -n 20 "$(logfile backend)" >&2 || true
exit 1
