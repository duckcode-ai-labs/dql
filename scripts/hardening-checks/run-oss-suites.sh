#!/bin/sh
# Runs every package's suite on one checkout, one after another. The CLI suite runs with every Node process recording the
# lookups and connections it starts off this machine (apps/cli/scripts/network-log.cjs, as `pnpm test:offline`
# does), and the sockets of its processes sampled every 0.3 s (sample-sockets.sh).
# usage: run-oss-suites.sh <oss repo> <evidence dir>
REPO="$(cd "$1" && pwd)"; OUT="$2"; HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$OUT"
# The real-DuckDB tests need a folder with the duckdb driver installed; they skip themselves without it.
export DQL_APP_DATASETS_DUCKDB_CONNECTOR_ROOT
step() {
  name="$1"; shift
  echo "== $name $(date +%H:%M:%S) $(uptime | sed 's/.*load averages*: //')" | tee -a "$OUT/summary.txt"
  start=$(date +%s)
  ( "$@" ) > "$OUT/$name.log" 2>&1
  code=$?
  echo "   exit $code in $(( $(date +%s) - start ))s" | tee -a "$OUT/summary.txt"
  grep -E "Test Files|Tests  |passed|failed" "$OUT/$name.log" | tail -4 | sed 's/^/   /' | tee -a "$OUT/summary.txt"
}
cd "$REPO" || exit 2
step tsc-force sh -c 'for p in packages/dql-core packages/dql-connectors packages/dql-mcp packages/dql-agent apps/cli apps/dql-notebook; do echo "-- $p"; (cd $p && npx tsc -b --force) || exit 1; done'
# The CLI suite runs in the background so its process tree can be sampled.
echo "== cli $(date +%H:%M:%S) $(uptime | sed 's/.*load averages*: //')" | tee -a "$OUT/summary.txt"
start=$(date +%s)
( cd apps/cli && DQL_NETWORK_LOG="$OUT/cli-netlog.jsonl" NODE_OPTIONS="--require $REPO/apps/cli/scripts/network-log.cjs" npx vitest run ) > "$OUT/cli.log" 2>&1 &
CLI=$!
"$HERE/sample-sockets.sh" "$OUT/cli-sockets.txt" "$CLI" &
SAMPLER=$!
wait $CLI; code=$?
wait $SAMPLER
echo "   exit $code in $(( $(date +%s) - start ))s" | tee -a "$OUT/summary.txt"
grep -E "Test Files|Tests  " "$OUT/cli.log" | tail -2 | sed 's/^/   /' | tee -a "$OUT/summary.txt"
cat "$OUT/cli-sockets.txt.summary" | sed 's/^/   /' | tee -a "$OUT/summary.txt"
step notebook sh -c 'cd apps/dql-notebook && npx vitest run --passWithNoTests --hookTimeout 30000'
step core sh -c 'cd packages/dql-core && npx vitest run'
step mcp sh -c 'cd packages/dql-mcp && npx vitest run'
step project sh -c 'cd packages/dql-project && npx vitest run'
step connectors sh -c 'cd packages/dql-connectors && npx vitest run'
step agent-lanes sh -c 'cd packages/dql-agent && node ./scripts/test-lanes.mjs'
echo "== done $(date +%H:%M:%S)" | tee -a "$OUT/summary.txt"
