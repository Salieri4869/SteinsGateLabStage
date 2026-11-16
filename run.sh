#!/usr/bin/env sh
# Usage: ./run.sh [port]   (default 8000)

cd "$(dirname "$0")" || exit 1

PORT=${1:-8000}
case "$PORT" in
    ''|*[!0-9]*) echo "[!] Port must be numeric, e.g. ./run.sh 8901"; exit 1 ;;
esac

if ! NODEV=$(node -v 2>/dev/null); then
    echo
    echo "[!] Node.js not found. Install the LTS build from:"
    echo "    https://nodejs.org/zh-cn/download"
    echo "    Then check with: node -v"
    echo
    exit 1
fi

MAJOR=${NODEV#v}
MAJOR=${MAJOR%%.*}
if [ "$MAJOR" -lt 18 ] 2>/dev/null; then
    echo "[!] Node.js 18+ required, found $NODEV."
    exit 1
fi

echo "[OK] Node $NODEV found. Starting on port $PORT ..."
echo "     Home: http://127.0.0.1:$PORT/"
echo

node main.mjs --port "$PORT" --open
STATUS=$?
echo
echo "E-mote server stopped (exit $STATUS)."
echo "If the port was in use, retry with: ./run.sh 8901"
exit "$STATUS"
