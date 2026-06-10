Solidify (улучши) промпт конкретной роли на основе накопленного feedback: $ARGUMENTS

Используй skill `plan-panel`. $ARGUMENTS = `role:<X>`.

## Flow

### Шаг 1 — Prepare payload

```bash
PAYLOAD=$(bash ~/.claude/skills/plan-panel/lib/solidify.sh prepare "$ROLE" 2>&1)
```

Скрипт вернёт:
- Текущий `roles/<role>.md` content
- Все feedback entries (jsonl) для этой роли
- Golden fixtures expected.json для regression context

Если feedback меньше threshold (default 10) — exit code 2 с подсказкой. Можно override через `PLAN_PANEL_SOLIDIFY_THRESHOLD=5` env var.

### Шаг 2 — Meta-agent analysis

Запусти **Agent tool** (Fable, single call) с prompt:

```
Ты — meta-agent skill plan-panel в режиме solidify. Твоя задача:
проанализировать accumulated feedback для роли <ROLE> и предложить
улучшения к её system prompt.

=== CURRENT ROLE.MD ===
<содержимое>

=== FEEDBACK ENTRIES (N total) ===
<jsonl entries>

=== GOLDEN FIXTURES METRICS ===
<expected.json snippets для regression context>

Анализируй:
1. Какие categories findings часто помечены useful=false? → их checklist points
   нужно убрать или calibrate (severity rubric, или явно exclude)
2. Какие areas часто отмечены noise=true (роль не должна была активироваться)?
   → activation rules в scoper нужно update'нуть (но это scoper.md, не текущая роль)
3. Какие edge cases часто не упоминались роли? → расширить checklist
4. Pattern в reasons — общая тема?

Верни proposed обновление role.md в виде ПОЛНОГО нового content. Сохрани:
- структуру (заголовки, checklist nums, output schema, anti-patterns, self-check)
- token budget рамки (12-пункта checklist максимум)

Также дай short summary:
- Что изменено и почему
- Какие regression risks (что-то может стать строже / мягче на golden fixtures?)
```

### Шаг 3 — Save proposed + show diff

Сохрани новый content от Claude в `~/.claude/skills/plan-panel/roles/_proposed/<role>.<ts>.md`:

```bash
PROPOSED_FILE="$HOME/.claude/skills/plan-panel/roles/_proposed/${ROLE}.$(date +%Y-%m-%d_%H-%M-%S).md"
mkdir -p "$(dirname "$PROPOSED_FILE")"
echo "<new content>" > "$PROPOSED_FILE"

diff -u ~/.claude/skills/plan-panel/roles/${ROLE}.md "$PROPOSED_FILE" | head -100
```

### Шаг 4 — Спроси user accept/reject через AskUserQuestion

Покажи:
- Summary что изменилось
- Diff (head -100 строк)
- Regression risks

Options:
- "Apply" — применить proposed, забекапить старое, archive feedback
- "Reject" — удалить proposed, сохранить feedback (повтор позже)
- "Save for later" — оставить proposed файл, не применять

### Шаг 5 — На accept

```bash
bash ~/.claude/skills/plan-panel/lib/solidify.sh apply "$ROLE" "$PROPOSED_FILE"
```

Это:
- Бэкапит текущий role.md → `roles/_history/<role>.<ts>.md`
- Применяет proposed → `roles/<role>.md`
- Архивирует feedback → `feedback/_processed/<role>.<ts>.jsonl`
- Удаляет proposed файл

После apply подскажи user:
- 💡 Запусти golden dataset чтобы проверить regression
- 💡 Хочешь поделиться с community? Запусти `/panel-share-prompt role:<X>`

### Шаг 5b — На reject

```bash
bash ~/.claude/skills/plan-panel/lib/solidify.sh reject "$ROLE" "$PROPOSED_FILE"
```

Удаляет proposed, **сохраняет** feedback (может пригодиться при следующей попытке).

## Anti-patterns

- ❌ НЕ применяй apply без user explicit accept — это меняет AI prompts (supply-chain поверхность)
- ❌ НЕ показывай raw feedback из jsonl пользователю в чате — могут проскочить sensitive details из планов
- ❌ НЕ запускай без accumulated feedback (мин 10 entries) — meta-agent сделает плохой anaylyze
- ❌ НЕ позволяй meta-agent'у "выдумать" findings из ничего — он должен опираться на feedback patterns

## Cost

Meta-agent — один Fable call (~10-15k input + 3-5k output) = ~$0.15 if API, $0 if Max. Один раз в 2-3 недели на роль.
