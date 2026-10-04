#!/bin/sh
# Every 0.3 s, list the TCP/UDP sockets of a process tree (the root PID and all its descendants) and
# keep the ones that are not loopback. Ends when the root PID exits.
# usage: sample-sockets.sh <outfile> <root pid>
OUT="$1"; ROOT="$2"; : > "$OUT.all"; N=0; MAXP=0
while kill -0 "$ROOT" 2>/dev/null; do
  PIDS=$(ps -Ao pid=,ppid= | awk -v root="$ROOT" '{ parent[$1]=$2 } END { for (p in parent) { q=p; while (q != "" && q != 0 && q != 1) { if (q == root) { print p; break } q=parent[q] } } }' | tr '\n' ',' | sed 's/,$//')
  if [ -n "$PIDS" ]; then
    C=$(echo "$PIDS" | tr ',' '\n' | wc -l | tr -d ' '); [ "$C" -gt "$MAXP" ] && MAXP=$C
    lsof -nP -a -p "$PIDS" -i 2>/dev/null | awk 'NR>1' >> "$OUT.all"
    N=$((N+1))
  fi
  sleep 0.3
done
sort -u "$OUT.all" -o "$OUT.all"
grep -v -E '127\.0\.0\.1|\[::1\]|localhost:|->localhost|TCP \*:|UDP \*:' "$OUT.all" > "$OUT"
echo "samples=$N max_processes=$MAXP socket_lines=$(wc -l < "$OUT.all" | tr -d ' ') non_loopback_lines=$(wc -l < "$OUT" | tr -d ' ')" > "$OUT.summary"
