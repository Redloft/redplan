Запусти multi-role review плана: $ARGUMENTS

Используй skill `plan-panel`. $ARGUMENTS может быть:
- Сам план (Markdown текст)
- Ссылка на файл с планом (`@plan.md`)
- Пусто — план = последнее значимое сообщение пользователя или результат недавнего обсуждения

## Flow (ВЫПОЛНЯЙ В ПОРЯДКЕ)

### Шаг 1 — Извлеки план и slug

`PLAN_TEXT` = текст плана.
`SLUG` = транслит первых ~40 chars в lowercase ASCII:

```bash
SLUG=$(printf '%s' "$PLAN_TEXT" | head -c 200 | python3 -c "
import sys, re
T = {'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'yo','ж':'zh','з':'z','и':'i','й':'y','к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r','с':'s','т':'t','у':'u','ф':'f','х':'kh','ц':'ts','ч':'ch','ш':'sh','щ':'sch','ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya'}
s = sys.stdin.read().lower().strip()
s = ''.join(T.get(c, c) for c in s)
s = re.sub(r'[^a-z0-9]+', '-', s).strip('-')[:40]
print(s or 'plan')
")
```

### Шаг 2 — Создай persistence dirs ПЕРВЫМ (до запуска workflow)

```bash
PATHS=$(bash ~/.claude/skills/plan-panel/lib/persist.sh "$PWD" "$SLUG")
PROJECT_DIR=$(echo "$PATHS" | cut -d'|' -f1)
CENTRAL_DIR=$(echo "$PATHS" | cut -d'|' -f2)
TS=$(echo "$PATHS" | cut -d'|' -f3)
RUN_ID=$(uuidgen | tr 'A-Z' 'a-z')   # или python3 -c "import uuid; print(uuid.uuid4())"
echo "$PLAN_TEXT" > "$PROJECT_DIR/plan.md"
```

### Шаг 3 — Определи mode

- `--lite` в $ARGUMENTS → mode=lite (3 роли, ~$0.20 if API)
- `--heavy` → mode=heavy
- `--ultra` → mode=ultra (+cross-model verify; **+$0.10-0.20 API даже на Max** — предупреди пользователя)
- иначе → mode=standard

### Шаг 4 — Запусти Workflow

```
Workflow({
  scriptPath: "~/.claude/skills/plan-panel/workflow/panel.js",
  args: {
    plan_text: PLAN_TEXT,
    project_slug: basename(PWD),
    cwd: PWD,
    mode: "<from step 3>",
    timestamp: TS,
    run_id: RUN_ID,
    project_dir: PROJECT_DIR,
    central_dir: CENTRAL_DIR
  }
})
```

### Шаг 5 — Запиши artifacts

После завершения workflow получишь `result.artifacts` — словарь `{filename: content}`. Записывай каждый файл в **оба** persistence dirs:

```bash
# Для каждого ключа в result.artifacts
for name in plan.md scope.json reviews.json review.md judge.json judge.md meta-judge.json meta-judge.md metadata.json; do
  # Извлеки contents из result.artifacts[name] (если есть) и положи в PROJECT_DIR
  # Затем дублируй в CENTRAL_DIR через cp (best-effort — если симлинк ломается на cloud-synced filesystem, не блокируй)
done
```

Claude должен сделать это через **Write tool** для каждого файла:
- `Write(PROJECT_DIR/<name>, content)` для каждого ключа в artifacts
- `Bash("cp -r $PROJECT_DIR/* $CENTRAL_DIR/" || echo "central mirror failed (non-fatal)")`

### Шаг 6 — Покажи пользователю

Сводный summary в чат:
1. **Verdict** (PASS / NEEDS-WORK / FAIL / UNCERTAIN) + confidence
2. **Top-5 priority actions** из judge (или meta-judge в ultra mode)
3. **Conflicts count + Gaps count**
4. **Skipped roles** если есть (Phase A не покрывает frontend/backend/data/ops — это нормально, judge помечает как gaps)
5. **Failed role count** если был timeout/null от какой-то роли
6. **Path к artifacts**: `<PROJECT_DIR>` (открой `judge.md` или `meta-judge.md`)
7. **В ultra mode**: summary cross-model agreement matrix (что все 3 согласны / что только 2 / уникальные от GPT и Gemini)
8. Подсказка: `Хочешь дать feedback по ролям? /panel-feedback role:<X> useful=true/false` (Phase B)

## Не делать

- НЕ запускать на тривиальных планах (scoper вернёт complexity=low → предложи пропустить)
- НЕ продолжать без явного `plan_text` — спросить если непонятно что ревьюить
- НЕ выводить весь review.md в чат — он длинный. Достаточно judge summary + top-5 actions + ссылка на artifacts.
- НЕ упускать шаг 5 — без него artifacts теряются (workflow возвращает content, не пишет на disk).
- НЕ запускать concurrent /plan-review на одном проекте без проверки (persist.sh пока не имеет lock — A2 todo).

## Phase A scope (текущий)

Реализованы: scoper, architect, qa, security, judge. Cross-model (ultra) — GPT-5 + Gemini Pro + meta-judge.
TBD Phase B: frontend, backend, data, ops; /panel-feedback; /panel-solidify; Stop-hook auto-trigger.

Если scoper выбирает frontend/backend/data/ops — workflow их **пропускает** и явно передаёт judge как `skipped_not_implemented` → judge упоминает их в `gaps`.
