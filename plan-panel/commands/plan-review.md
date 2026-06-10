Запусти multi-role review плана: $ARGUMENTS

Используй skill `plan-panel`. $ARGUMENTS может быть:
- Сам план (Markdown текст)
- Ссылка на файл (`@plan.md`)
- Пусто — план = последнее значимое сообщение пользователя или результат недавнего обсуждения

## Default flow — Auto-mode с одной точкой подтверждения

Default mode = **`auto`** (scoper сам выбирает оптимальный режим).

### Шаг 1 — Извлеки план + setup persistence

```bash
# Извлеки PLAN_TEXT; сгенерируй SLUG через python translit + create dirs
SLUG=$(echo "$PLAN_TEXT" | head -c 200 | python3 -c "
import sys, re
T = {'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'yo','ж':'zh','з':'z','и':'i','й':'y','к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r','с':'s','т':'t','у':'u','ф':'f','х':'kh','ц':'ts','ч':'ch','ш':'sh','щ':'sch','ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya'}
s = sys.stdin.read().lower().strip()
s = ''.join(T.get(c, c) for c in s)
s = re.sub(r'[^a-z0-9]+', '-', s).strip('-')[:40]
print(s or 'plan')
")
PATHS=$(bash ~/.claude/skills/plan-panel/lib/persist.sh "$PWD" "$SLUG")
PROJECT_DIR=$(echo "$PATHS" | cut -d'|' -f1)
CENTRAL_DIR=$(echo "$PATHS" | cut -d'|' -f2)
TS=$(echo "$PATHS" | cut -d'|' -f3)
RUN_ID=$(uuidgen | tr 'A-Z' 'a-z')
echo "$PLAN_TEXT" > "$PROJECT_DIR/plan.md"
```

### Шаг 2 — Определи initial mode

Парсинг $ARGUMENTS:
- `--lite` → `mode=lite` (skip Шаг 3)
- `--heavy` → `mode=heavy` (skip Шаг 3)
- `--ultra` → `mode=ultra` (skip Шаг 3)
- `--standard` → `mode=standard` (skip Шаг 3)
- иначе → `mode=auto` (запусти Шаг 3 first)

### Шаг 3 — (только если mode=auto) Auto-scope phase

Запусти Workflow с `mode="auto-scope-only"`:
```
Workflow({
  scriptPath: "~/.claude/skills/plan-panel/workflow/panel.js",
  args: {
    plan_text: PLAN_TEXT,
    project_slug: basename(PWD),
    cwd: PWD,
    mode: "auto-scope-only",
    timestamp: TS,
    run_id: RUN_ID,
    project_dir: PROJECT_DIR,
    central_dir: CENTRAL_DIR
  }
})
```

Workflow вернёт `{ scope_only: true, scoper, recommended_mode, mode_reasoning, needs_user_confirmation, selected_roles_for_review, skipped_roles_not_implemented }`.

### Шаг 4 — (опционально) Спроси пользователя

**Если `needs_user_confirmation === false`** → авто-продолжаем с `mode=recommended_mode`. Никакого вопроса.

**Если `needs_user_confirmation === true`** → используй AskUserQuestion:
```
"Scoper определил: <complexity> сложность, <N> ролей (<scope_tags>).

Recommendation: <recommended_mode> — <mode_reasoning>

Какой режим запустить?"

Options (4 max):
- "<recommended_mode> (рекомендуется)" — описание + cost/time estimate
- альтернатива (например если рекомендован heavy → также показать ultra)
- более лёгкая альтернатива (lite)
- "skip" если recommended_mode='skip' (план тривиальный)
```

Cost estimates:
- lite: $0 на Max, ~30 сек
- standard: $0 на Max, ~1-2 мин
- heavy: $0 на Max, ~2-3 мин (cross-examination)
- ultra: $0 + **+$0.10-0.20 API** (GPT-5 + Gemini Pro), ~4-5 мин

### Шаг 5 — Запусти full Workflow

С выбранным mode + всеми остальными args:
```
Workflow({
  scriptPath: "~/.claude/skills/plan-panel/workflow/panel.js",
  args: {
    plan_text: PLAN_TEXT,
    project_slug, cwd, mode: CHOSEN_MODE,
    timestamp: TS, run_id: RUN_ID,
    project_dir: PROJECT_DIR, central_dir: CENTRAL_DIR
  }
})
```

Workflow перезапустит scoper, но он быстрый (Haiku) и предсказуем; для оптимизации в будущем — добавим `precomputed_scoper` arg.

### Шаг 6 — Запиши artifacts

После завершения workflow → `result.artifacts` это `{filename: content}` словарь:
- Запиши каждый файл в `PROJECT_DIR` через **Write tool**
- Скопируй в `CENTRAL_DIR` через `Bash("cp -r $PROJECT_DIR/* $CENTRAL_DIR/" || true)` (best-effort)

### Шаг 7 — Покажи user

Сводный summary:
1. **Verdict** (PASS/NEEDS-WORK/FAIL/UNCERTAIN) + confidence
2. **Top-5 priority actions** из judge (или meta-judge в ultra mode)
3. **Mode used** + почему (если auto-mode сработал silent)
4. **Conflicts/Gaps count**
5. **Skipped roles** упоминание
6. **Path к artifacts**: `<PROJECT_DIR>`

## Anti-patterns

- ❌ Не задавай вопрос про mode если `needs_user_confirmation=false` — это **friction**, нарушает auto-flow
- ❌ Не запускай Шаг 3 (scope-only) если юзер передал явный mode флаг — он уже решил
- ❌ Не выводи весь review.md в чат — длинный. Достаточно judge summary + top-5 actions + path
- ❌ Не запускай на тривиальных планах если scoper сказал `recommended_mode=skip` — спроси пользователя готов ли он тратить время

## Phase B1 status

Все 9 ролей реализованы: scoper, architect, qa, security, frontend, backend, data, ops, judge. Cross-model в ultra (GPT-5 + Gemini Pro + meta-judge).

Phase B2 (отложен): /panel-feedback collection + /panel-solidify auto-trigger + signed TG approve flow.
