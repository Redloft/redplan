#!/usr/bin/env bash
# redplan doctor — diagnoses install + optional features.
#
# Usage:
#   bash ~/.claude/skills/plan-panel/lib/doctor.sh
#
# Exit 0 if core works (lite/standard/heavy modes). Optional features
# (ultra mode requires OpenAI + Gemini API) are reported but don't fail.
set -uo pipefail

green() { printf '\033[32m✓\033[0m %s\n' "$*"; }
yellow(){ printf '\033[33m⚠\033[0m %s\n' "$*"; }
red()   { printf '\033[31m✗\033[0m %s\n' "$*"; }
blue()  { printf '\033[34mℹ\033[0m %s\n' "$*"; }
bold()  { printf '\033[1m%s\033[0m\n' "$*"; }

CORE_OK=true

bold "── Core dependencies ──"
for cmd in git curl jq node python3 uuidgen; do
  if command -v "$cmd" >/dev/null 2>&1; then
    ver=$($cmd --version 2>&1 | head -1 || echo '?')
    green "$cmd: ${ver:0:60}"
  else
    red "$cmd: NOT FOUND"
    CORE_OK=false
  fi
done

echo
bold "── Installation ──"
INSTALL_DIR="${REDPLAN_INSTALL_DIR:-$HOME/.claude/skills/plan-panel}"
COMMANDS_DIR="${REDPLAN_COMMANDS_DIR:-$HOME/.claude/commands}"

if [ -f "$INSTALL_DIR/SKILL.md" ]; then
  green "skill installed: $INSTALL_DIR"
  if [ -d "$INSTALL_DIR/.git" ]; then
    branch=$(git -C "$INSTALL_DIR" branch --show-current 2>/dev/null || echo '?')
    commit=$(git -C "$INSTALL_DIR" rev-parse --short HEAD 2>/dev/null || echo '?')
    blue "  branch: $branch, commit: $commit"
  fi
else
  red "skill not found at $INSTALL_DIR"
  CORE_OK=false
fi

if [ -f "$COMMANDS_DIR/plan-review.md" ]; then
  green "/plan-review command: $COMMANDS_DIR/plan-review.md"
else
  red "/plan-review command NOT FOUND in $COMMANDS_DIR"
  CORE_OK=false
fi

# Validate role specs + workflow
echo
bold "── Skill integrity ──"
for f in SKILL.md _shared.md roles/scoper.md roles/architect.md roles/qa.md roles/security.md roles/judge.md workflow/panel.js lib/persist.sh lib/cross-model.sh; do
  if [ -f "$INSTALL_DIR/$f" ]; then
    green "$f"
  else
    red "$f MISSING"
    CORE_OK=false
  fi
done

if [ -f "$INSTALL_DIR/workflow/panel.js" ]; then
  if node --check "$INSTALL_DIR/workflow/panel.js" 2>/dev/null; then
    green "workflow/panel.js syntax OK"
  else
    red "workflow/panel.js has syntax error"
    CORE_OK=false
  fi
fi

# Persistence test
echo
bold "── Persistence ──"
TMP=$(mktemp -d)
if PATHS=$(bash "$INSTALL_DIR/lib/persist.sh" "$TMP" "doctor-test" 2>&1); then
  green "persist.sh works"
  PROJECT_DIR=$(echo "$PATHS" | cut -d'|' -f1)
  blue "  test artifact: $PROJECT_DIR"
  rm -rf "$TMP" "${PROJECT_DIR%/*}" 2>/dev/null || true
else
  red "persist.sh failed: $PATHS"
  CORE_OK=false
fi

# Central root resolution
CENTRAL=""
if [ -n "${PLAN_PANEL_CENTRAL:-}" ]; then
  CENTRAL="$PLAN_PANEL_CENTRAL (PLAN_PANEL_CENTRAL)"
elif [ -n "${CLAUDECORE_PATH:-}" ]; then
  CENTRAL="$CLAUDECORE_PATH/plan-panel (CLAUDECORE_PATH fallback)"
else
  CENTRAL="$HOME/.plan-panel-central (default)"
fi
blue "central mirror: $CENTRAL"

# ─── Optional: ultra mode (cross-model) ───
echo
bold "── Optional: ultra mode (cross-model verify) ──"

OPENAI_OK=false
GEMINI_OK=false

# Check env vars
if [ -n "${OPENAI_API_KEY:-}" ]; then
  green "OPENAI_API_KEY env: set (${#OPENAI_API_KEY} chars)"
  OPENAI_OK=true
fi
if [ -n "${GEMINI_API_KEY:-}" ]; then
  green "GEMINI_API_KEY env: set (${#GEMINI_API_KEY} chars)"
  GEMINI_OK=true
fi

# Check 1Password CLI fallback
if [ "$OPENAI_OK" = false ] || [ "$GEMINI_OK" = false ]; then
  if command -v op >/dev/null 2>&1; then
    blue "1Password CLI detected — cross-model.sh self-wraps via 'op run'"
    blue "  Expected vault items: OpenAI, Gemini (with 'credential' field)"
  else
    yellow "no env vars + no 1Password CLI — ultra mode unavailable"
    yellow "  To enable: export OPENAI_API_KEY + GEMINI_API_KEY"
    yellow "  Or: brew install --cask 1password-cli + create items 'OpenAI' and 'Gemini'"
  fi
fi

# SOCKS5 proxy (optional for Gemini)
if [ -n "${GEMINI_PROXY:-}" ]; then
  blue "GEMINI_PROXY env: set — Gemini calls routed via SOCKS5"
fi

# ─── Fixtures ───
echo
bold "── Golden fixtures ──"
if [ -d "$INSTALL_DIR/fixtures/golden" ]; then
  bash "$INSTALL_DIR/lib/run-golden.sh" 2>&1 | grep -E '^(Summary|✓|✗)' | head -10
else
  yellow "fixtures/golden not found (non-critical for runtime)"
fi

# ─── Summary ───
echo
bold "── Summary ──"
if [ "$CORE_OK" = true ]; then
  green "Core works. You can use /plan-review now."
  echo '  - lite / standard / heavy modes: $0 on Max subscription (counts vs usage limits)'
  # Ultra ready если оба ключа в env ИЛИ есть op CLI (через который cross-model.sh self-wraps)
  HAS_OP=false; command -v op >/dev/null 2>&1 && HAS_OP=true
  if { [ "$OPENAI_OK" = true ] && [ "$GEMINI_OK" = true ]; } || [ "$HAS_OP" = true ]; then
    green 'Ultra mode (cross-model verify): ready (~$0.10/run API cost via OpenAI + Gemini)'
  else
    yellow "Ultra mode: needs API keys — set OPENAI_API_KEY + GEMINI_API_KEY, or install 1Password CLI"
  fi
  exit 0
else
  red "Core has problems. Fix the ✗ items above before using /plan-review."
  exit 1
fi
