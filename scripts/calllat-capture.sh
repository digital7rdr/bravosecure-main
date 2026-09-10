#!/usr/bin/env bash
# [CALLLAT] capture helper — audit Step 0 (docs/audits/CALL_JOIN_LATENCY_AUDIT_2026-08-20.md).
#
# Usage:
#   scripts/calllat-capture.sh clear                      # clear logcat on every attached device
#   scripts/calllat-capture.sh dump <label> [outDir]      # dump the call-diagnostic lines per device
#
# `dump` writes <outDir>/<label>-<serial>.log with only the release-visible call
# lanes ([CALLLAT] [CALLDIAG] [CALLSM] [LAGDIAG] [bravo.*]) so a run stays small,
# then renders the waterfall to <outDir>/<label>-waterfall.md via
# scripts/calllat-waterfall.mjs. Pair it with the staging relay:
#   ssh ... "docker logs -t --since 10m bravo-staging-msgr | grep -a '\[CALL\]\|\[SFU\]'"
set -euo pipefail
cmd="${1:-}"; label="${2:-run}"; out="${3:-calllat-runs}"
serials=$(adb devices | awk 'NR>1 && $2=="device" {print $1}')
[ -z "$serials" ] && { echo "no adb devices" >&2; exit 1; }
case "$cmd" in
  clear)
    for s in $serials; do adb -s "$s" logcat -c && echo "cleared $s"; done ;;
  dump)
    mkdir -p "$out"; files=()
    for s in $serials; do
      f="$out/${label}-${s//[:.]/_}.log"
      adb -s "$s" logcat -d -v threadtime 2>/dev/null \
        | grep -a "\[CALLLAT\]\|\[CALLDIAG\]\|\[CALLSM\]\|\[LAGDIAG\]\|\[bravo\.\(call\|groupcall\|signalling\)\|NOTIFLAT" > "$f" || true
      echo "$f ($(wc -l < "$f") lines)"; files+=("$f")
    done
    node "$(dirname "$0")/calllat-waterfall.mjs" "${files[@]}" > "$out/${label}-waterfall.md"
    echo "waterfall: $out/${label}-waterfall.md" ;;
  *) echo "usage: $0 clear | dump <label> [outDir]" >&2; exit 2 ;;
esac
