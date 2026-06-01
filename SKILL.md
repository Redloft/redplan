---
name: plan-panel
description: |
  Use when user wants a multi-role review of a proposed plan / RFC / implementation strategy.
  Spawns a "panel" of expert subagents (architect, qa, judge — always; security/frontend/backend/data/ops conditional based on detected scope), each with a strict checklist-driven protocol. Final judge synthesizes findings into priority-ranked action list with cross-examination of conflicts.

  TRIGGER on:
  • «проверь план», «верифицируй план», «собери панель», «посмотри план с разных сторон»
  • «что упустил в плане», «что важно учесть»
  • «прогони ревью», «нужна команда экспертов», «нужно мнение архитектора + qa + ...»
  • "review this plan", "verify this plan", "panel review", "expert review"
  • Explicit: «/plan-review», «/plan-panel», «/panel»

  Также активируется когда пользователь явно даёт большой план и просит «прежде чем начнём» / «прежде чем кодить» / «давай разберёмся» — это сигнал что нужна верификация.

  HEAVY MODE по умолчанию (5-8 ролей + Opus judge с cross-examination конфликтов между ролями). Lite — через флаг `--lite`. Cost ~$0.70-2.50 за full run.
allowed-tools:
  - Bash
  - Read
  - Write
  - Workflow
  - Agent
  - AskUserQuestion
---

# plan-panel — multi-role plan verification

## Flow (3 фазы)

```
User план → /plan-review
   ↓
Phase 1: SCOPE DETECTION (1 agent, Haiku)
   → читает план + project context (~/projects/<slug>.md если найден)
   → возвращает scope.json: { scope_tags, selected_roles, complexity, rationale }
   → пользователь видит выбранные роли, может override
   ↓
Phase 2: PARALLEL ROLE REVIEW (N agents, Sonnet)
   → выбранные роли работают параллельно с одинаковым input (план + scope.json)
   → каждая выдаёт structured JSON по схеме из _shared.md
   → агрегация в review.md (sole-author rule)
   ↓
Phase 3: JUDGE SYNTHESIS (1 agent, Opus, HEAVY mode)
   → читает все role outputs
   → ищет конфликты между ролями
   → если есть конфликт — ДЕЛАЕТ cross-examination round: задаёт уточняющий
     вопрос конкретной роли и переоценивает
   → выдаёт priority-ranked action list + ищет gaps (что НИ ОДНА роль не покрыла)
   → final verdict: PASS / FAIL / NEEDS-WORK
   ↓
Persistence:
   project/.plan-panel/<ts>-<slug>/  + копия в $PLAN_PANEL_CENTRAL/<project>/<ts>/
   plan.md, scope.json, review.md, judge.md, metadata.json
   ↓
Финал: показ judge.md пользователю + опциональный prompt на /panel-feedback
```

## Запуск

```bash
~/.claude/skills/plan-panel/workflow/panel.js
```

Это Workflow script. Вызывается через **Workflow tool** Claude Code когда срабатывает trigger. См. `workflow/panel.js` для детерминистской орк.

## Trigger phrases / activation

См. frontmatter `description`. Когда пользователь пишет «проверь план», «собери панель» и т.п. — этот skill активируется, дальше Claude должен:

1. Понять что план — это либо текущее сообщение пользователя, либо последний значимый план в session (если он сказал «проверь то что мы только что обсудили»)
2. Сохранить план в `<persistence_dir>/plan.md` (по схеме ниже)
3. Запустить `Workflow({scriptPath: "~/.claude/skills/plan-panel/workflow/panel.js", args: {plan_path, project_slug, mode}})`
4. После завершения — показать пользователю summary из judge.md + предложить /panel-feedback

## Persistence dirs (hybrid)

**Project-local** (canonical source of truth): `<cwd>/.plan-panel/<YYYY-MM-DD_HH-MM>-<plan-slug>/`
**Central mirror** (best-effort replica): `$PLAN_PANEL_CENTRAL/<project-slug>/<YYYY-MM-DD_HH-MM>-<plan-slug>/`

Central root resolution (lib/persist.sh):
1. `$PLAN_PANEL_CENTRAL` env (если задана) — рекомендуется для пользователей
2. `$CLAUDECORE_PATH/plan-panel/` (если задана) — для legacy ClaudeCore setup
3. Default: `~/.plan-panel-central/`

`<project-slug>` определяется как `basename($PWD)` sanitized. Опционально: если у тебя есть skill для project mapping (например ClaudeCore project-map) — можешь pre-resolve project slug и передать через `args.project_slug`.

Создаются обе папки + symlink central→project (best-effort — если cloud-sync filesystem не поддерживает symlinks, не блокирует workflow).

## Modes

- **standard** (default heavy): scoper + architect + qa + judge + relevant conditional roles. Judge с cross-examination. Opus для judge, Sonnet для остальных. ~$0.70-2.50 *if API*, $0 *if Max*.
- **--lite**: scoper + architect + qa + judge. Без conditional ролей, без cross-exam. Sonnet везде. ~$0.20 *if API*, $0 *if Max*.
- **--ultra**: standard + Phase 4 «CrossModel». Финальный план + Claude judge.md прогоняется через **GPT-5 + Gemini 2.5 Pro параллельно** как outside opinion. Meta-judge синтезирует 3 точки зрения. Cross-model часть **всегда платная** (API через 1Password items `OpenAI` + `Gemini`): ~+$0.10-0.20 на real план. Для критических планов где важно «третье мнение».

## Output to user

После завершения workflow возвращает:
- Path к `judge.md`
- Summary action list (top-5 priority)
- Conflict count (если были)
- Gap count (что ни одна роль не покрыла)
- Кнопка: «дай feedback по ролям» → `/panel-feedback`

## Не забывать

- **Не запускать на тривиальных планах** (1-2 шага, без сложности). Scoper должен возвращать `complexity: 'low'` → можно skip с предложением "план тривиальный, нужен ли panel?".
- **Не двойной запуск**: если в этой же сессии уже был /plan-review на тот же план — спросить пользователя re-run или показать предыдущий результат.
- **Версионирование plan.md**: если план эволюционировал — каждый run создаёт новую папку timestamp'a, старые не перезаписываются.

## Acceptance criteria (Done-when) для каждой фазы

| Фаза | Done when |
|---|---|
| **1. Persistence setup** (caller, до workflow) | `persist.sh` экзитит 0, возвращает 3-part pipe-delimited string `<project_dir>|<central_dir>|<ts>`. Оба dir'а существуют, project_dir записываемый. `plan.md` сохранён в project_dir. |
| **2. Scope (scoper agent)** | JSON по `SCOPE_SCHEMA`. `confidence >= 0.3`. `selected_roles.length >= 3`. Иначе — fail-fast (см. `_shared.md` §9), верни UNCERTAIN с user_action_required. |
| **3. Review (parallel roles)** | Каждая роль — JSON по `FINDINGS_SCHEMA`. Минимум 1 actionable suggestion per finding. `confidence >= 0.5` ИЛИ verdict=UNCERTAIN явно. Если timeout/null — judge видит это в execution_report. |
| **4. Synthesize (judge)** | JSON по `JUDGE_SCHEMA`. Если `skipped_not_implemented` непустой — gaps ДОЛЖЕН их упомянуть. `final_verdict_reasoning` объясняет verdict явно (не "see findings"). |
| **5. CrossModel** (только ultra) | `cross-model.sh` exit 0 ИЛИ partial result с явным `errors[]` array. GPT и Gemini оба JSON-parseable. Meta-judge синтезирует с `agreement_summary` (all_three / 2_of_3 / unique_to_*). |
| **6. Artifacts** (caller, после workflow) | Все 9 файлов в project_dir: `plan.md, scope.json, reviews.json, review.md, judge.json, judge.md, metadata.json` + (ultra) `meta-judge.json, meta-judge.md`. Central dir mirror через `cp` (best-effort — non-fatal если cloud-sync лажает). |
| **7. User summary** | В чате: verdict + confidence + top-5 priority actions + conflicts/gaps count + skipped_not_implemented mention + path к artifacts. Не вываливать весь review.md. |

## Edge cases

| Edge case | Handling |
|---|---|
| Scoper вернул `confidence < 0.3` | Fail-fast в orchestrator. Возврат `{ error: 'low-confidence-scope', user_action_required: '...' }`. НЕ запускать roles + judge. |
| Scoper вернул `selected_roles.length < 3` | То же — fail-fast |
| 2+ роли вернули null/timeout | Workflow продолжает с тем что есть. Judge видит `execution_report.failed_or_null_roles` и упоминает в summary "N ролей отвалилось". |
| Scoper выбрал роль не из Phase A (frontend/backend/data/ops) | Workflow её ПРОПУСКАЕТ + передаёт judge как `skipped_not_implemented`. Judge ОБЯЗАН отметить как gap. |
| Cross-model partial failure (GPT работает, Gemini падает) | `cross-model.sh` пишет error в `errors[]`, остальной JSON содержит то что есть. Meta-judge синтезирует из 2 источников вместо 3, отмечает degraded в summary. |
| Concurrent /plan-review | Каждый run создаёт unique `<ts>-<slug>` dir. Коллизия в 1 секунду крайне маловероятна. **Lock-файл для serialization** — Phase B (когда добавится /panel-feedback который правит artifacts). |
| cloud-synced filesystem symlink сломался | persist.sh пытается ln, но `\|\| true` — non-fatal. Local PROJECT_DIR остаётся canonical. Central mirror можно перегенерировать через `cp -r project_dir/* central_dir/`. |
| Plan слишком большой (>20k chars) | Token budget per role exceeded. Roles вернут UNCERTAIN. Judge поднимет gap. **Решение**: разбить план на несколько /plan-review запусков по logical sections. |
