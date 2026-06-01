Сделай PR-ready bundle чтобы поделиться улучшением роли с upstream redplan: $ARGUMENTS

Используй skill `plan-panel`. $ARGUMENTS = `role:<X> [--dry-run]`.

Это **опциональный** шаг **после** того как ты:
1. Накопил feedback через `/panel-feedback`
2. Запустил `/panel-solidify` и accept'нул improved prompt
3. Хочешь поделиться улучшением с community (других не обязывает использовать)

## Запуск

```bash
~/.claude/skills/plan-panel/lib/share-prompt.sh "$ROLE" $DRY_RUN
```

Скрипт:
- Проверит что текущий `roles/<role>.md` отличается от upstream main
- Создаст `/tmp/redplan-share-<role>-<ts>/` с:
  - `role-diff.patch` — git diff (только role.md)
  - `abstract-metrics.json` — counters БЕЗ raw reason text
  - `PR-body.md` — шаблон описания PR
  - `README.txt` — инструкции для push + PR create

## Что НЕ включается в PR

⚠️ **Никогда** не пушится:
- Raw feedback из `feedback/<role>.jsonl` (может содержать sensitive plan content)
- `_history/` локальная версионная цепочка (приватная)
- `_processed/` архив feedback

Только: diff role.md + aggregated counters (totals per useful/false/noise).

## Покажи user

После выполнения скрипта:
1. Path к bundle
2. Stats: lines added/removed, feedback batches count
3. Подсказка: «открой PR-body.md, заполни секцию "What changed" абстрактным описанием паттерна (не конкретные finding bodies)»
4. Команды для push + PR create из README.txt

## Anti-patterns

- ❌ НЕ копировать raw reason из feedback в PR body — может проскочить private info
- ❌ НЕ забывать --dry-run перед первым реальным запуском — убедись что diff именно тот что хотел
- ❌ НЕ pushing если diff пустой — нечего шарить, скрипт сам exit'нет
