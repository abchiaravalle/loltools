#!/usr/bin/env bash
# Run one site's real-Chrome test suite against a host and print a one-line result.
#   scripts/test_site.sh <key> <host> [extra args...]
#   scripts/test_site.sh words wordcounter-lol.amplifi.studio
set -u
cd "$(dirname "$0")/.."
key="$1"; host="$2"; shift 2
log="/tmp/loltest/live-$key.log"
mkdir -p /tmp/loltest
timeout 560 node "tests/$key/test.cjs" "https://$host/" "$@" > "$log" 2>&1
code=$?
summary=$(grep -E 'passed|HARNESS' "$log" | tail -1)
printf '%-6s %-34s exit=%s  %s\n' "$key" "$host" "$code" "$summary"
grep -E '^FAIL' "$log" | head -6 | cut -c1-300
exit $code
