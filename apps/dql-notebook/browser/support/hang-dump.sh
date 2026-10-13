#!/usr/bin/env bash
# TEMPORARY DIAGNOSTIC: native state of every Chromium renderer when a page hangs.
echo "===== HANG DUMP $(date +%T) ====="
ps -eo pid,ppid,stat,pcpu,etime,args --sort=-pcpu | grep -E "headless_shell|chrom" | grep -v grep | cut -c1-220 | head -20
for pid in $(pgrep -f -- "--type=renderer"); do
  echo "----- renderer $pid -----"
  ps -L -o tid,stat,pcpu,wchan:32,comm -p "$pid" | head -40
  cat /proc/$pid/stack 2>/dev/null | head -5 || true
  sudo -n gdb -p "$pid" -batch -nx -ex "set pagination off" -ex "info sharedlibrary" 2>/dev/null | grep -cE "^0x" || true
  sudo -n gdb -p "$pid" -batch -nx -ex "set pagination off" -ex "thread 1" -ex "bt 60" -ex "thread apply all bt 6" 2>&1 | grep -vE "^\[New LWP|^warning|Missing separate" | head -220
done
for pid in $(pgrep -f "headless_shell" | while read p; do grep -qa -- "--type=" /proc/$p/cmdline || echo $p; done); do
  echo "----- browser $pid -----"
  ps -L -o tid,stat,pcpu,wchan:32,comm -p "$pid" | head -60
  sudo -n gdb -p "$pid" -batch -nx -ex "set pagination off" -ex "thread apply all bt 25" 2>&1 | grep -vE "^\[New LWP|^warning|Missing separate" > /tmp/browser-bt.txt
  echo "threads with font/fc frames:"
  awk '/^Thread /{t=$0} /[Ff]ont|Fc[A-Z]|fontconfig|Typeface/{print t; print}' /tmp/browser-bt.txt | head -120
  echo "-- main thread --"
  awk '/^Thread 1 /{p=1} p' /tmp/browser-bt.txt | head -30
done
echo "===== END HANG DUMP ====="
