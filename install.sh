#!/bin/sh
# qc-check installer. No npm involved.
#
#   curl -fsSL https://raw.githubusercontent.com/mohamedma872/qc-check/main/install.sh | sh
#
# It puts the tool in ~/.qc-check and links the `qc-check` command into a bin
# directory on your PATH. Nothing is installed system-wide and no sudo is used.
#
#   sh install.sh --prefix ~/bin     link the command somewhere else
#   sh install.sh --ref v1.2.0       install a tag or branch instead of main
#   sh install.sh --update           update an existing install
#   sh install.sh --uninstall        remove it
#
# Node 18 or newer is required, because the tool and the device scripts are
# JavaScript. Everything else it needs is already on a developer machine.

set -eu

REPO_URL="https://github.com/mohamedma872/qc-check.git"
TARBALL_URL="https://codeload.github.com/mohamedma872/qc-check/tar.gz"
HOME_DIR="${QC_CHECK_HOME:-$HOME/.qc-check}"
REF="main"
PREFIX=""
ACTION="install"

say() { printf '%s\n' "$*"; }
die() { printf 'install: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="${2:-}"; shift 2 ;;
    --ref) REF="${2:-main}"; shift 2 ;;
    --update) ACTION="update"; shift ;;
    --uninstall) ACTION="uninstall"; shift ;;
    --help|-h)
      sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

# Pick a bin directory the user can write to, preferring one already on PATH.
choose_prefix() {
  if [ -n "$PREFIX" ]; then printf '%s' "$PREFIX"; return; fi
  for candidate in "$HOME/.local/bin" "$HOME/bin" "/usr/local/bin"; do
    case ":$PATH:" in
      *":$candidate:"*)
        if [ -d "$candidate" ] && [ -w "$candidate" ]; then printf '%s' "$candidate"; return; fi
        ;;
    esac
  done
  printf '%s' "$HOME/.local/bin"
}

uninstall() {
  target="$(choose_prefix)/qc-check"
  [ -L "$target" ] || [ -f "$target" ] && rm -f "$target" && say "removed $target"
  if [ -d "$HOME_DIR" ]; then
    rm -rf "$HOME_DIR"
    say "removed $HOME_DIR"
  fi
  say ""
  say "qc-check is gone. Your qc.config.json, qc/ and qc-reports/ are untouched."
  exit 0
}

[ "$ACTION" = "uninstall" ] && uninstall

have node || die "Node is required but not on PATH. Install Node 18 or newer, then re-run."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$NODE_MAJOR" -ge 18 ] 2>/dev/null || die "Node 18 or newer is required (found $(node --version 2>/dev/null || echo none))."

fetch_with_git() {
  if [ -d "$HOME_DIR/.git" ]; then
    say "updating $HOME_DIR ($REF)"
    git -C "$HOME_DIR" fetch --quiet --depth 1 origin "$REF"
    git -C "$HOME_DIR" checkout --quiet FETCH_HEAD
  else
    say "downloading qc-check ($REF) into $HOME_DIR"
    rm -rf "$HOME_DIR"
    git clone --quiet --depth 1 --branch "$REF" "$REPO_URL" "$HOME_DIR" 2>/dev/null \
      || git clone --quiet --depth 1 "$REPO_URL" "$HOME_DIR"
  fi
}

# No git? Take the tarball instead, so a bare machine can still install.
fetch_with_curl() {
  have curl || die "neither git nor curl is available; install one of them."
  tmp="$(mktemp -d)"
  say "downloading qc-check ($REF) into $HOME_DIR"
  curl -fsSL "$TARBALL_URL/$REF" -o "$tmp/qc.tar.gz" || die "download failed for ref \"$REF\"."
  rm -rf "$HOME_DIR"
  mkdir -p "$HOME_DIR"
  tar -xzf "$tmp/qc.tar.gz" -C "$HOME_DIR" --strip-components 1
  rm -rf "$tmp"
}

if have git; then fetch_with_git; else fetch_with_curl; fi

[ -f "$HOME_DIR/bin/qc-check.js" ] || die "download looks incomplete: $HOME_DIR/bin/qc-check.js is missing."
chmod +x "$HOME_DIR/bin/qc-check.js" "$HOME_DIR/qc-check" 2>/dev/null || true

BIN_DIR="$(choose_prefix)"
mkdir -p "$BIN_DIR"
[ -w "$BIN_DIR" ] || die "$BIN_DIR is not writable. Re-run with --prefix <dir> pointing somewhere you own."

ln -sf "$HOME_DIR/bin/qc-check.js" "$BIN_DIR/qc-check"
say "linked $BIN_DIR/qc-check"

VERSION="$(node -p "require('$HOME_DIR/package.json').version" 2>/dev/null || echo unknown)"
say ""
say "qc-check $VERSION installed."

case ":$PATH:" in
  *":$BIN_DIR:"*)
    say ""
    say "Next:"
    say "  cd /path/to/your/app"
    say "  qc-check setup"
    ;;
  *)
    say ""
    say "$BIN_DIR is not on your PATH yet. Add this to your shell profile:"
    say ""
    say "  export PATH=\"$BIN_DIR:\$PATH\""
    say ""
    say "Then open a new shell and run: qc-check setup"
    ;;
esac
