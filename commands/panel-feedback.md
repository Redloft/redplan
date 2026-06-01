Дай feedback по конкретной роли из последнего /plan-review: $ARGUMENTS

Используй skill `plan-panel`. $ARGUMENTS обычно в формате:
- `role:<X> useful=<true|false|noise> reason="..."`

Где:
- `role` — одна из: scoper, architect, qa, security, frontend, backend, data, ops, judge
- `useful` — `true` (finding был полезный), `false` (был неточный/неправильный), `noise` (роль вообще не должна была активироваться)
- `reason` — короткая причина (до 500 chars). НЕ пиши полное содержимое плана — только паттерн.

## Парсинг $ARGUMENTS

Через regex или explicit user prompt извлеки 3 значения. Если непонятно — спроси через AskUserQuestion (3 вопроса: role / useful / reason).

Дополнительно можно передать `run_id=<uuid>` и `plan_hash=<sha>` из последней metadata.json (если есть в текущем контексте session).

## Запуск

```bash
~/.claude/skills/plan-panel/lib/feedback.sh "$ROLE" "$USEFUL" "$REASON" "$RUN_ID" "$PLAN_HASH"
```

Скрипт сам:
- Валидирует role / useful enum
- Sanitize reason (newlines, length cap 500)
- Append JSONL line в `~/.claude/skills/plan-panel/feedback/<role>.jsonl` (private, gitignored)
- Покажет total count; если ≥10 entries — подскажет запустить `/panel-solidify role:<X>`

## Не делать

- ❌ НЕ передавать в reason полное содержимое плана — только pattern observation
- ❌ НЕ commit'ить feedback files в git — они в .gitignore по причине: могут содержать sensitive contextual info из планов
- ❌ НЕ запускать без role/useful/reason — это required args
