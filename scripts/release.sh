#!/bin/sh
# Release this mod to the folder Claude Code loads it from.
# Sessions load ~/.claude/mods-release/session-watcher (CLAUDE_CODE_PLUGIN_DIRS), not this repo, so a
# half-finished edit here never reloads into every open session. This script copies only a version that
# validates and passes its tests, and swaps it in whole.
set -eu
SRC="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$HOME/.claude/mods-release/session-watcher"
claude plugin validate "$SRC"
# The render tests have 5-second timeouts that can trip on a busy machine: one retry before giving up.
claude plugin test "$SRC" || claude plugin test "$SRC"
TMP="$DEST.new.$$"
mkdir -p "$(dirname "$DEST")"
rsync -a --delete --exclude .git --exclude '.claude-plugin/types' "$SRC/" "$TMP/"
if [ -d "$DEST" ]; then mv "$DEST" "$DEST.old.$$"; fi
mv "$TMP" "$DEST"
rm -rf "$DEST.old.$$"
echo "released $(git -C "$SRC" rev-parse --short HEAD 2>/dev/null || echo working-tree) to $DEST"
