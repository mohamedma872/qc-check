#!/usr/bin/env bash
# One-time Appium setup for the QC agent.
# Run this once in the host repo before the first QC pass.
#
# Usage: setup.sh [--help]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ] || [ "${1:-}" = "help" ]; then
  cat <<'USAGE'
QC agent setup

Installs Appium v2 and the platform drivers the QC skill drives:
  UiAutomator2 (Android), XCUITest (iOS, macOS hosts only).

Usage: setup.sh [--help]

After it finishes, configure the host repo:
  qc.config.json        devices, app flavors, backend, code map
  <credentialsFile>     QC test account, gitignored (path from qc.config.json)
USAGE
  exit 0
fi

echo "=== QC agent setup ==="
echo ""

echo "Installing Appium v2 ..."
npm install -g appium@latest

echo "Installing the UiAutomator2 driver (Android) ..."
appium driver install uiautomator2 || echo "  (already installed)"

# XCUITest only runs on macOS hosts with Xcode; skip it elsewhere instead of
# failing the whole setup.
if [ "$(uname -s)" = "Darwin" ]; then
  echo "Installing the XCUITest driver (iOS) ..."
  appium driver install xcuitest || echo "  (already installed)"
else
  echo "Skipping the XCUITest driver: iOS automation needs a macOS host."
fi

echo ""
echo "=== Setup complete ==="
echo ""

CONFIG_SUMMARY=""
if CONFIG_SUMMARY=$(node "$SCRIPT_DIR/config.js" 2>/dev/null); then
  echo "Resolved configuration:"
  echo "$CONFIG_SUMMARY" | sed 's/^/  /'
else
  echo "No qc.config.json found above this directory. Create one with:"
  echo "  npx qc-check init            (or copy qc.config.example.json to qc.config.json)"
fi

echo ""
echo "Next steps:"
echo "  1. Fill in qc.config.json: devices, app flavors, backend, code map."
echo "  2. Create the credentials file named by \"credentialsFile\" in qc.config.json"
echo "     from the shipped template, and keep it out of version control."
echo "  3. Start Appium:  appium --port <devices.appium.port>   (default 4723)"
echo "  4. Install the build for the flavor you will QC on the target emulator"
echo "     or simulator, using this repo's own build command."
echo "  5. Run the QC skill against a ticket, for example: qc-check ABC-123"
echo ""
echo "Verify the wiring without a device:"
echo "  node $SCRIPT_DIR/config.js"
echo "  node $SCRIPT_DIR/driver.js --help"
