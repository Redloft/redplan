#!/usr/bin/env bash
# redplan installer for Claude Code
#
# One-liner:
#   curl -fsSL https://raw.githubusercontent.com/Redloft/redplan/main/install.sh | bash
#
# Or after clone:
#   bash install.sh
#
# Installs to ~/.claude/skills/plan-panel/ and copies slash-command to ~/.claude/commands/
# Idempotent — safe to re-run for updates.
set -euo pipefail

REPO_URL="${REDPLAN_REPO_URL:-https://github.com/Redloft/redplan.git}"
INSTALL_DIR="${REDPLAN_INSTALL_DIR:-$HOME/.claude/skills/plan-panel}"
COMMANDS_DIR="${REDPLAN_COMMANDS_DIR:-$HOME/.claude/commands}"

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow(){ printf '\033[33m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }

bold "🌶  redplan installer"
echo

# ─── 1. Required deps ───
echo "Checking required deps..."
MISSING=()
for cmd in git curl jq node python3; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    MISSING+=("$cmd")
  fi
done
if [ ${#MISSING[@]} -gt 0 ]; then
  red "✗ Missing required deps: ${MISSING[*]}"
  echo
  echo "Install on macOS:"
  echo "  brew install git curl jq node python"
  echo "Install on Ubuntu/Debian:"
  echo "  sudo apt-get install git curl jq nodejs python3"
  exit 1
fi
green "✓ All required deps present"

NODE_VER=$(node --version | sed 's/v//;s/\..*//')
if [ "$NODE_VER" -lt 18 ]; then
  yellow "⚠ Node version is v$NODE_VER. Skill tested on Node ≥18."
fi

# ─── 2. Install skill files ───
echo
echo "Installing to $INSTALL_DIR..."
if [ -d "$INSTALL_DIR/.git" ]; then
  yellow "→ Existing install found. Updating via git pull..."
  git -C "$INSTALL_DIR" pull --quiet --ff-only origin main 2>&1 | sed 's/^/  /'
  green "✓ Updated to latest"
else
  if [ -d "$INSTALL_DIR" ] && [ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]; then
    red "✗ $INSTALL_DIR exists and is not empty (not a git repo)."
    echo "  Backup or remove it, then re-run."
    exit 1
  fi
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone --quiet "$REPO_URL" "$INSTALL_DIR"
  green "✓ Cloned to $INSTALL_DIR"
fi

# ─── 3. Copy slash-command ───
echo
echo "Installing slash-command to $COMMANDS_DIR..."
mkdir -p "$COMMANDS_DIR"
cp "$INSTALL_DIR/commands/plan-review.md" "$COMMANDS_DIR/plan-review.md"
green "✓ /plan-review installed"

# ─── 4. Run doctor for optional features ───
echo
bold "─── Optional features ───"
bash "$INSTALL_DIR/lib/doctor.sh" || true

# ─── 5. Done ───
echo
bold "🎯 Installation complete"
echo
echo "Usage:"
echo "  In any Claude Code session:"
echo "    /plan-review <your plan as text>"
echo
echo "Documentation:"
echo "  Local:  $INSTALL_DIR/README.md"
echo "  Online: https://github.com/Redloft/redplan"
echo
echo "Troubleshooting:"
echo "  bash $INSTALL_DIR/lib/doctor.sh"
