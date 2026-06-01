# plan-panel — shared protocol

Этот файл — общий контракт для **всех** ролей. Любая роль обязана соблюдать схему output, severity rubric и sole-author rule. Без этого synthesis и self-improve не работают.

## 1. Output schema (СТРОГО JSON)

Каждая роль возвращает один JSON-объект:

```json
{
  "role": "architect|qa|security|frontend|backend|data|ops",
  "verdict": "PASS|FAIL|UNCERTAIN",
  "confidence": 0.85,
  "findings": [
    {
      "severity": "critical|warning|suggestion",
      "area": "короткая категория (например 'data-model', 'auth-flow', 'rollback')",
      "issue": "что именно не так / упущено / рискованно",
      "suggestion": "конкретное actionable исправление",
      "ref": "необязательно — ссылка на step плана / файл / строку"
    }
  ],
  "summary": "1-2 предложения общего вывода",
  "self_check_passed": true
}
```

**Правила**:
- `verdict=PASS` ⇔ нет critical findings и роль уверена в плане (`confidence ≥ 0.7`)
- `verdict=FAIL` ⇔ есть хотя бы один `critical` finding
- `verdict=UNCERTAIN` ⇔ конф нижe 0.7 ИЛИ план вне зоны экспертизы роли (роль должна явно сказать почему в `summary`)
- Минимум **1 actionable suggestion** в findings, иначе роль помечается `noise` в feedback log
- `self_check_passed=false` если роль не уверена что покрыла свой checklist целиком

## 2. Severity rubric (одинаковая для всех ролей)

| Уровень | Когда применять | Должно блокировать релиз? |
|---|---|---|
| **critical** | Уязвимость, потеря данных, нарушение договорённости с пользователем, blocker для следующего шага | Да |
| **warning** | Технический долг, недостающая обработка edge-cases, плохая практика, потенциальный риск | Не сразу, но фикс в той же итерации |
| **suggestion** | Improvement, оптимизация, лучший паттерн, polish | Опционально |

**Анти-паттерн**: помечать всё как critical. Если у тебя 5+ critical findings — пересмотри, возможно ты в режиме "всё плохо".

## 3. Sole-author rule

В artifact `review.md` каждая роль пишет **только в свою секцию** `## <Role>`. Никакая роль не правит чужие секции. Judge синтезирует, но не правит исходные секции — пишет в свой `## Judge`.

## 4. Token budget

| Роль | Input max | Output max | Model |
|---|---:|---:|---|
| scoper | 4k | 1k | Haiku |
| architect / qa / frontend / backend / data / ops / security | 4k | 2k | Sonnet |
| judge | 12k | 3k | Opus |

Если роль явно вышла за бюджет — это сигнал что план слишком большой для одного review (нужно дробить на несколько /plan-review запусков).

## 5. Composability с другими skills

Роль может ССЫЛАТЬСЯ на другой skill для context, но **не вызывает** его (skills не композируются на ходу). Маркер: `→ см. ~/.claude/skills/<name>/SKILL.md`.

Примеры опциональных привязок (НЕ требуются для базовой работы skill):
- `security` → если у тебя есть skill для secrets management (например 1Password CLI workflow) — ссылайся на его SKILL.md
- `frontend` → если есть skills для design system / animation guidelines
- `data` → supabase skill / postgres best-practices skill
- `ops` → опциональная server inventory (например `$KB_PATH/servers/`) + project map
- Любая роль → optional project context из knowledge base если у юзера установлен project-map skill

Эти привязки **discovery-based** — роль читает SKILL.md если находит его, иначе работает stand-alone. Не блокирует выполнение если файлы отсутствуют.

## 6. Что роль НЕ делает

- ❌ Не пишет код в свой output (только findings + suggestions)
- ❌ Не вызывает других ролей
- ❌ Не редактирует план — только аннотирует
- ❌ Не говорит "плана нет, нужно больше деталей" — если плана недостаточно, говорит **что именно** недостаёт (это и есть finding с severity warning)

## 7. Input envelope (что роль получает от orchestrator)

```
review-роли (architect/qa/security/frontend/backend/data/ops):
  {
    plan_text: string,                  // оригинал плана пользователя
    scope: <scoper output JSON>,         // tags, complexity, rationale
    role_spec_file: string,              // путь к role .md (как self-reference)
  }

judge:
  {
    plan_text,
    scope,
    execution_report: {                  // ← добавлено после meta-self-review
      attempted_roles: [...],
      completed_roles: [...],
      failed_or_null_roles: [...],
      skipped_not_implemented: [...],
    },
    role_reviews: [...]                  // массив JSON от всех completed ролей
  }
```

Judge обязан в своём output отметить любые `skipped_not_implemented` роли как **gaps** (это области которые не были покрыты).

## 8. Persistence — canonical source of truth

Persistence dual, но **НЕ симметричный**:

| Location | Role | Что хранится |
|---|---|---|
| `<cwd>/.plan-panel/<ts>-<slug>/` | **canonical** — single source of truth | plan.md, scope.json, review.md, judge.md, metadata.json. `/panel-feedback` ПИШЕТ сюда. |
| `$PLAN_PANEL_CENTRAL/<project>/<ts>/` | **best-effort replica** (symlink или копия) | те же файлы, для cross-project аналитики и UI. См. lib/persist.sh для resolution order. |
| `~/.claude/skills/plan-panel/roles/<role>.md` | **canonical** | role prompts, **никогда** не копируются в CloudCore — версионирование в `roles/<role>.history/` локально |
| `~/.claude/skills/plan-panel/feedback/<role>.jsonl` | **canonical** | feedback log, **никогда** не в CloudCore (может содержать sensitive plan-context) |

**Если symlink ломается** (например cloud-synced filesystem не поддерживает symlinks или временные sync conflicts) — local `.plan-panel/` остаётся source of truth, central можно перегенерировать через `cp -r project_dir/* central_dir/`.

## 9. Fail-fast guard (orchestrator level)

Workflow обязан остановиться рано если:
- `scoper.confidence < 0.3` → план не distinguishable от не-плана, возвращаем clarification request пользователю **без Opus call**
- `selected_roles.length < 3` → недостаточно coverage для panel
- 2+ роли вернули `null` (timeout/crash) → degraded run, judge получает явный execution_report (см. §7)
