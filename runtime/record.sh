#!/usr/bin/env bash
# QC - screen recording for the current Appium session (UiAutomator2/XCUITest).
# Defensive: recording is flaky on headless emulators; a failed stop never exits
# non-zero hard enough to block QC - screenshots remain the primary evidence.
#
# Usage:
#   record.sh start [timeLimitSeconds]   # default 1800 (30 min, Appium max)
#   record.sh stop [outfile.mp4]         # bare name => saved in the reports dir
#   record.sh --help
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SESSION_FILE="${QC_SESSION_FILE:-/tmp/qc-session.json}"

usage() {
  cat <<'USAGE'
QC screen recording

Usage:
  record.sh start [timeLimitSeconds]   start recording (default limit 1800s)
  record.sh stop [outfile.mp4]         stop and save the video
  record.sh --help                     show this help

An argument without a "/" is saved in the reports directory from
project.reportsDir in qc.config.json. With no argument the file is named
recording-<timestamp>.mp4 there.

Requires an active session created by driver.js connect. The Appium endpoint
comes from the session record, falling back to devices.appium in qc.config.json.

Environment:
  QC_SESSION_FILE   session state path (default /tmp/qc-session.json)
USAGE
}

case "${1:-}" in
  --help|-h|help)
    usage
    exit 0
    ;;
esac

if [ ! -f "$SESSION_FILE" ]; then
  echo "ERROR: no active QC session ($SESSION_FILE missing). Run driver.js connect first." >&2
  exit 1
fi

# Session id plus the endpoint it was opened against, in one read.
SESSION_INFO=$(node -e '
const fs = require("fs");
const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (!s.sessionId) { console.error("session file has no sessionId"); process.exit(1); }
process.stdout.write([s.sessionId, s.host || "", s.port || ""].join(" "));
' "$SESSION_FILE") || exit 1

SID=$(echo "$SESSION_INFO" | awk '{print $1}')
HOST=$(echo "$SESSION_INFO" | awk '{print $2}')
PORT=$(echo "$SESSION_INFO" | awk '{print $3}')
[ -n "$HOST" ] || HOST=$(node "$SCRIPT_DIR/config.js" --appium-host 2>/dev/null || echo 127.0.0.1)
[ -n "$PORT" ] || PORT=$(node "$SCRIPT_DIR/config.js" --appium-port 2>/dev/null || echo 4723)
APPIUM="http://$HOST:$PORT"

reports_dir() {
  node "$SCRIPT_DIR/config.js" --reports-dir 2>/dev/null || echo "qc-reports"
}

case "${1:-}" in
  start)
    LIMIT="${2:-1800}"
    RESP=$(curl -s -X POST "$APPIUM/session/$SID/appium/start_recording_screen" \
      -H 'Content-Type: application/json' \
      -d "{\"options\":{\"timeLimit\":$LIMIT,\"bitRate\":4000000}}")
    if echo "$RESP" | grep -q '"error"'; then
      echo "WARN: start_recording_screen failed ($(echo "$RESP" | head -c 120)) - continuing with screenshots only"
    else
      echo "REC: recording (limit ${LIMIT}s)"
    fi
    ;;
  stop)
    OUT="${2:-}"
    if [ -z "$OUT" ]; then
      OUT="recording-$(date +%Y%m%d-%H%M%S).mp4"
    fi
    case "$OUT" in
      */*) : ;;                       # explicit path, used as given
      *)   OUT="$(reports_dir)/$OUT" ;;
    esac
    mkdir -p "$(dirname "$OUT")"
    # Node decodes the base64 payload: it is already a hard dependency here,
    # unlike python3.
    curl -s -X POST "$APPIUM/session/$SID/appium/stop_recording_screen" \
      -H 'Content-Type: application/json' -d '{}' \
      | OUT="$OUT" node -e '
const fs = require("fs");
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", c => { raw += c; });
process.stdin.on("end", () => {
  let v = null;
  try { v = (JSON.parse(raw) || {}).value; } catch { v = null; }
  if (v && typeof v === "object") { v = v.value; }
  // Buffer.from ignores non-base64 bytes instead of throwing, so an error
  // payload would be written out as a tiny broken file. Check the shape first.
  const looksBase64 = typeof v === "string" && /^[A-Za-z0-9+/=\s]+$/.test(v);
  if (looksBase64 && v.length > 100) {
    const out = process.env.OUT;
    fs.writeFileSync(out, Buffer.from(v, "base64"));
    console.log("OK: saved " + out + " (" + fs.statSync(out).size + " bytes)");
  } else {
    console.log("WARN: recording EMPTY on this device - use the per-step screenshots as evidence");
  }
});
'
    ;;
  *)
    usage >&2
    exit 1
    ;;
esac
