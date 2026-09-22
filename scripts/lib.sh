#!/usr/bin/env bash
# Shared helpers for the start/stop scripts. Sourced, never executed directly.
#
# Everything here is deliberately self-locating: REPO_ROOT is derived from this
# file's own path, so the scripts carry no server-specific paths and can live in
# the repository without turning into a machine-specific artifact.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$REPO_ROOT/.run"

# The same two numbers frontend/vite.config.ts reads. Exported so the Vite
# process inherits them and the proxy target cannot drift from the real port.
export BACKEND_PORT="${BACKEND_PORT:-19080}"
export FRONTEND_PORT="${FRONTEND_PORT:-19073}"

mkdir -p "$RUN_DIR"

pidfile() { echo "$RUN_DIR/$1.pid"; }
logfile() { echo "$RUN_DIR/$1.log"; }

# alive <name> - is the recorded pid a live process?
alive() {
  local f
  f="$(pidfile "$1")"
  [ -f "$f" ] || return 1
  local pid
  pid="$(cat "$f" 2>/dev/null || true)"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null
}

current_pid() { cat "$(pidfile "$1")" 2>/dev/null || true; }

# port_free <port> - is anything already listening? Returns 1 if taken.
# Falls back to "assume free" when neither ss nor lsof is installed: refusing to
# start on a missing tool would be worse than starting and finding out.
port_free() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | grep -q "[:.]$port " && return 1
  elif command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 && return 1
  fi
  return 0
}

# refuse_if_taken <name> <port> - a taken port is a hard stop, not something to
# work around. Vite would otherwise move to the next free port, and a drifted
# port is invisible to the security group and to whatever we told the proxy.
refuse_if_taken() {
  local name="$1" port="$2"
  if ! port_free "$port"; then
    {
      echo "[$name] port $port is already in use - refusing to start."
      echo "         端口被占用时不要让它自己换一个：换掉的端口安全组与代理都不知道。"
      echo "         先确认占用者（ss -ltnp | grep :$port），或改用别的端口："
      echo "           BACKEND_PORT=$BACKEND_PORT FRONTEND_PORT=$FRONTEND_PORT $0"
    } >&2
    exit 1
  fi
}

# stop_one <name> [grace_seconds] - SIGTERM, wait, then SIGKILL.
# The wait matters: the Go server closes its DB pool on SIGTERM, and Vite
# releases the port. Killing immediately and restarting can hand the new process
# a port the old one has not let go of yet.
stop_one() {
  local name="$1" grace="${2:-15}"
  local f
  f="$(pidfile "$name")"

  if ! alive "$name"; then
    echo "[$name] not running"
    rm -f "$f"
    return 0
  fi

  local pid
  pid="$(current_pid "$name")"
  echo "[$name] stopping pid $pid (SIGTERM)"
  kill "$pid" 2>/dev/null || true

  local i=0
  while kill -0 "$pid" 2>/dev/null; do
    i=$((i + 1))
    if [ "$i" -ge "$grace" ]; then
      echo "[$name] still alive after ${grace}s - sending SIGKILL" >&2
      kill -9 "$pid" 2>/dev/null || true
      break
    fi
    sleep 1
  done

  rm -f "$f"
  echo "[$name] stopped"
}

# wait_http <url> <seconds> - the difference between "the process forked" and
# "the service answers". A server that dies on a bad DB_DSN forks fine and then
# exits; without this, start would report success on a dead service.
wait_http() {
  local url="$1" seconds="${2:-15}"
  if ! command -v curl >/dev/null 2>&1; then
    echo "  (curl not installed - skipping readiness probe)"
    return 0
  fi
  local i=0
  while [ "$i" -lt "$((seconds * 2))" ]; do
    if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then
      return 0
    fi
    i=$((i + 1))
    sleep 0.5
  done
  return 1
}

banner() { echo "=== $(date '+%F %T') $* ==="; }
