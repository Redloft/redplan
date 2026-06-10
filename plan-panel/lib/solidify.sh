#!/usr/bin/env bash
# panel-solidify — анализирует накопленный feedback для одной роли и
# готовит candidate-обновление к её role.md промпту.
#
# Это shell-обёртка: реальная LLM работа делается Claude'ом через /panel-solidify
# слэш-команду (которая читает этот script + использует Agent tool для analysis).
#
# Эта обёртка:
#   - валидирует наличие feedback
#   - готовит payload для meta-agent (feedback + текущий role.md + golden fixtures)
#   - после Claude вернётся с proposed diff — script помогает с acceptance flow
#     (показать diff, ждать accept, применить + версионировать)
#
# Usage:
#   solidify.sh prepare <role>     — собирает payload для meta-agent
#   solidify.sh apply <role> <proposed_file>  — применяет diff с versioning + backup
#   solidify.sh reject <role> <proposed_file> — удаляет proposed
set -euo pipefail

CMD="${1:?usage: solidify.sh prepare|apply|reject <role> [args]}"
ROLE="${2:?need role}"

VALID_ROLES="scoper architect qa security frontend backend data ops judge"
if ! echo "$VALID_ROLES" | grep -qw "$ROLE"; then
  echo "✗ invalid role: $ROLE" >&2
  exit 1
fi

SKILL_ROOT="${PLAN_PANEL_SKILL_ROOT:-$HOME/.claude/skills/plan-panel}"
ROLE_FILE="$SKILL_ROOT/roles/${ROLE}.md"
FEEDBACK_FILE="$SKILL_ROOT/feedback/${ROLE}.jsonl"
HISTORY_DIR="$SKILL_ROOT/roles/_history"
PROPOSED_DIR="$SKILL_ROOT/roles/_proposed"

case "$CMD" in
  prepare)
    [ -f "$ROLE_FILE" ] || { echo "✗ role file missing: $ROLE_FILE" >&2; exit 1; }
    [ -f "$FEEDBACK_FILE" ] || { echo "✗ no feedback for role '$ROLE'. Use /panel-feedback first." >&2; exit 1; }

    FB_COUNT=$(wc -l < "$FEEDBACK_FILE" | tr -d ' ')
    THRESHOLD="${PLAN_PANEL_SOLIDIFY_THRESHOLD:-10}"
    if [ "$FB_COUNT" -lt "$THRESHOLD" ]; then
      echo "⚠ only $FB_COUNT feedback entries (threshold $THRESHOLD)" >&2
      echo "  Recommended: accumulate more feedback first, or force with PLAN_PANEL_SOLIDIFY_THRESHOLD=$FB_COUNT" >&2
      exit 2
    fi

    # Print payload to stdout (Claude reads this through Bash output)
    echo "=== ROLE: $ROLE ==="
    echo "=== CURRENT ROLE.MD ($(wc -l < "$ROLE_FILE" | tr -d ' ') lines) ==="
    cat "$ROLE_FILE"
    echo
    echo "=== FEEDBACK ENTRIES ($FB_COUNT total) ==="
    cat "$FEEDBACK_FILE"
    echo
    echo "=== GOLDEN FIXTURES (для regression context) ==="
    if [ -d "$SKILL_ROOT/fixtures/golden" ]; then
      for d in "$SKILL_ROOT"/fixtures/golden/*/; do
        [ -d "$d" ] || continue
        name=$(basename "$d")
        echo "--- $name ---"
        [ -f "$d/expected.json" ] && jq -c '{expected_verdict, expected_selected_roles_must_include, min_findings_per_role}' "$d/expected.json"
      done
    fi
    ;;

  apply)
    PROPOSED="${3:?need proposed file path}"
    [ -f "$PROPOSED" ] || { echo "✗ proposed file missing: $PROPOSED" >&2; exit 1; }
    [ -f "$ROLE_FILE" ] || { echo "✗ role file missing: $ROLE_FILE" >&2; exit 1; }

    # Versioning: bump current to _history/<role>.<ts>.md
    mkdir -p "$HISTORY_DIR"
    TS=$(date +%Y-%m-%d_%H-%M-%S)
    BACKUP="$HISTORY_DIR/${ROLE}.${TS}.md"
    cp "$ROLE_FILE" "$BACKUP"
    echo "✓ backed up current $ROLE.md → $BACKUP"

    # Apply proposed
    cp "$PROPOSED" "$ROLE_FILE"
    echo "✓ applied proposed prompt to $ROLE_FILE"

    # Mark feedback as processed (rename .jsonl → .processed.<ts>.jsonl)
    if [ -f "$FEEDBACK_FILE" ]; then
      mkdir -p "$SKILL_ROOT/feedback/_processed"
      mv "$FEEDBACK_FILE" "$SKILL_ROOT/feedback/_processed/${ROLE}.${TS}.jsonl"
      echo "✓ archived feedback → feedback/_processed/${ROLE}.${TS}.jsonl"
    fi

    # Remove proposed
    rm -f "$PROPOSED"

    echo
    echo "💡 Next: run golden regression check (Phase B2 TBD: lib/run-golden.sh real-comparison)"
    echo "💡 Want to share this improvement back to upstream? Run /panel-share-prompt role:$ROLE"
    ;;

  reject)
    PROPOSED="${3:?need proposed file path}"
    if [ -f "$PROPOSED" ]; then
      rm -f "$PROPOSED"
      echo "✓ proposed prompt rejected and removed"
    fi
    # Keep feedback — user might want to retry later
    echo "  (feedback log preserved — будет использован в следующем /panel-solidify)"
    ;;

  *)
    echo "✗ unknown command: $CMD" >&2
    echo "  usage: solidify.sh prepare|apply|reject <role> [proposed_file]" >&2
    exit 1
    ;;
esac
