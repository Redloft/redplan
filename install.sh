#!/usr/bin/env bash
# redplan installer for Claude Code — installs the plan-panel + finalize skills.
#
# One-liner:
#   curl -fsSL https://raw.githubusercontent.com/Redloft/redplan/main/install.sh | bash
# Or after clone:
#   bash install.sh
#
# Installs:
#   plan-panel → ~/.claude/skills/plan-panel
#   finalize   → ~/.claude/skills/finalize   (shares plan-panel/lib via relative symlinks)
#   commands   → ~/.claude/commands/*.md
# Idempotent — safe to re-run for updates.
set -euo pipefail

REPO_URL="${REDPLAN_REPO_URL:-https://github.com/Redloft/redplan.git}"
SKILLS_DIR="${REDPLAN_SKILLS_DIR:-$HOME/.claude/skills}"
COMMANDS_DIR="${REDPLAN_COMMANDS_DIR:-$HOME/.claude/commands}"

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow(){ printf '\033[33m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }

bold "🌶  redplan installer (plan-panel + finalize)"
echo

# ─── 1. Required deps ───
echo "Checking required deps..."
MISSING=()
for cmd in git curl jq node python3; do
  command -v "$cmd" >/dev/null 2>&1 || MISSING+=("$cmd")
done
if [ ${#MISSING[@]} -gt 0 ]; then
  red "✗ Missing required deps: ${MISSING[*]}"
  echo "  macOS:  brew install git curl jq node python"
  echo "  Debian: sudo apt-get install git curl jq nodejs python3"
  exit 1
fi
green "✓ All required deps present"
NODE_VER=$(node --version | sed 's/v//;s/\..*//')
[ "$NODE_VER" -lt 18 ] && yellow "⚠ Node v$NODE_VER — skill tested on Node ≥18."

# ─── 2. Locate source (local clone or fetch to a temp dir) ───
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLEANUP=""
if [ ! -d "$SRC/plan-panel" ] || [ ! -d "$SRC/finalize" ]; then
  echo "Fetching redplan source..."
  SRC="$(mktemp -d)"; CLEANUP="$SRC"
  git clone --quiet --depth 1 "$REPO_URL" "$SRC"
fi

# ─── 3. Install both skills (preserve finalize's relative symlinks → plan-panel/lib) ───
echo
echo "Installing skills to $SKILLS_DIR ..."
mkdir -p "$SKILLS_DIR"
for skill in plan-panel finalize; do
  dest="$SKILLS_DIR/$skill"
  [ -d "$dest" ] && { yellow "→ replacing existing $skill"; rm -rf "$dest"; }
  cp -R "$SRC/$skill" "$dest"          # cp -R preserves symlinks
  green "✓ $skill → $dest"
done
# verify the shared-lib symlinks resolve
for f in checkpoint.sh strip-secrets.sh; do
  [ -e "$SKILLS_DIR/finalize/lib/$f" ] || red "⚠ finalize/lib/$f does not resolve — is plan-panel installed?"
done

# ─── 4. Slash-commands ───
echo
echo "Installing slash-commands to $COMMANDS_DIR ..."
mkdir -p "$COMMANDS_DIR"
cp "$SKILLS_DIR/plan-panel/commands/"*.md "$COMMANDS_DIR/" 2>/dev/null || true
green "✓ commands installed: $(ls "$SKILLS_DIR/plan-panel/commands" | sed 's/\.md//' | tr '\n' ' ')"

# ─── 5. Optional features ───
echo
bold "─── Optional features ───"
bash "$SKILLS_DIR/plan-panel/lib/doctor.sh" 2>/dev/null || true

[ -n "$CLEANUP" ] && rm -rf "$CLEANUP"

echo
bold "🎯 Installation complete"
echo "Usage in any Claude Code session:"
echo "  /plan-review <plan text>      — multi-role plan verification"
echo "  /finalize                     — stabilize + code-review the working diff"
echo "Docs: https://github.com/Redloft/redplan"
