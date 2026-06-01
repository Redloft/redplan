// plan-panel Phase A — orchestrator workflow
//
// Args ожидаются:
//   args.plan_text     — текст плана (Markdown ok)
//   args.project_slug  — optional, для project context lookup
//   args.cwd           — current working dir (для project-local persistence)
//   args.mode          — 'standard' (default) | 'lite' | 'heavy'
//   args.timestamp     — YYYY-MM-DD_HH-MM, для имени папки (передаётся снаружи)
//
// Возвращает: { judge_path, summary, conflicts, gaps, priority_actions, artifacts_dir }

export const meta = {
  name: 'plan-panel',
  description: 'Multi-role plan verification — scope detection, parallel role review, Claude judge + (ultra) cross-model verify через GPT-5 + Gemini 2.5 Pro',
  phases: [
    { title: 'Scope', detail: 'Haiku scoper выбирает релевантные роли' },
    { title: 'Review', detail: 'параллельный review каждой выбранной ролью' },
    { title: 'Synthesize', detail: 'Opus judge с cross-examination конфликтов' },
    { title: 'CrossModel', detail: 'только в --ultra: GPT-5 + Gemini 2.5 Pro как outside opinion + meta-judge синтез' },
  ],
}

const ROLE_DEFINITIONS = {
  scoper:    { file: '~/.claude/skills/plan-panel/roles/scoper.md',    model: 'haiku' },
  architect: { file: '~/.claude/skills/plan-panel/roles/architect.md', model: 'sonnet' },
  qa:        { file: '~/.claude/skills/plan-panel/roles/qa.md',        model: 'sonnet' },
  security:  { file: '~/.claude/skills/plan-panel/roles/security.md',  model: 'sonnet' },
  judge:     { file: '~/.claude/skills/plan-panel/roles/judge.md',     model: 'opus' },
  // Phase B: frontend, backend, data, ops
}

const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['role', 'verdict', 'confidence', 'findings', 'summary', 'self_check_passed'],
  additionalProperties: true,
  properties: {
    role: { type: 'string' },
    verdict: { enum: ['PASS', 'FAIL', 'UNCERTAIN', 'NEEDS-WORK'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'area', 'issue', 'suggestion'],
        additionalProperties: true,
        properties: {
          severity: { enum: ['critical', 'warning', 'suggestion'] },
          area: { type: 'string' },
          issue: { type: 'string' },
          suggestion: { type: 'string' },
          ref: { type: 'string' },
        },
      },
    },
    summary: { type: 'string' },
    self_check_passed: { type: 'boolean' },
  },
}

const SCOPE_SCHEMA = {
  type: 'object',
  required: ['scope_tags', 'selected_roles', 'complexity', 'rationale'],
  additionalProperties: true,
  properties: {
    scope_tags: { type: 'array', items: { type: 'string' } },
    selected_roles: { type: 'array', items: { type: 'string' } },
    complexity: { enum: ['low', 'medium', 'high'] },
    rationale: { type: 'string' },
    confidence: { type: 'number' },
  },
}

const JUDGE_SCHEMA = {
  type: 'object',
  required: ['role', 'verdict', 'confidence', 'findings', 'priority_actions', 'summary', 'final_verdict_reasoning'],
  additionalProperties: true,
  properties: {
    role: { const: 'judge' },
    verdict: { enum: ['PASS', 'FAIL', 'NEEDS-WORK', 'UNCERTAIN'] },
    confidence: { type: 'number' },
    findings: { type: 'array' },
    conflicts: { type: 'array' },
    gaps: { type: 'array' },
    priority_actions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['rank', 'severity', 'action'],
        additionalProperties: true,
        properties: {
          rank: { type: 'number' },
          severity: { enum: ['critical', 'warning', 'suggestion'] },
          action: { type: 'string' },
          owner_role: { type: 'string' },
          estimated_effort: { type: 'string' },
        },
      },
    },
    summary: { type: 'string' },
    final_verdict_reasoning: { type: 'string' },
  },
}

// Args могут прийти как object (правильно) или как JSON-string (когда caller не парсит) —
// поддерживаем оба варианта чтобы не зависеть от вызывающей стороны.
let parsedArgs = args
if (typeof args === 'string') {
  try { parsedArgs = JSON.parse(args) } catch { parsedArgs = { plan_text: args } }
}

const planText = parsedArgs?.plan_text || 'NO_PLAN_PROVIDED'
const projectSlug = parsedArgs?.project_slug || 'unknown-project'
const mode = parsedArgs?.mode || 'standard'
const cwd = parsedArgs?.cwd || ''
const timestamp = parsedArgs?.timestamp || 'now'
const projectDir = parsedArgs?.project_dir || ''
const centralDir = parsedArgs?.central_dir || ''
// run_id: передаётся caller'ом для correlation. Если не передан — пометим как 'unknown'
// (Date.now/random запрещены в workflow scripts; caller должен сгенерировать через persist.sh или uuid)
const runId = parsedArgs?.run_id || 'unknown-run-id'

log(`Mode: ${mode} · project: ${projectSlug} · plan length: ${planText.length} chars`)
if (planText === 'NO_PLAN_PROVIDED') {
  log(`⚠️  plan_text not provided in args. typeof args = ${typeof args}`)
}

// ============= Phase 1: SCOPE =============
phase('Scope')

const scoper = await agent(
  `Ты — scoper из skill plan-panel. Прочитай role spec ниже и применяй ПУНКТУАЛЬНО.\n\n` +
  `=== ROLE SPEC ===\n` +
  `Прочитай файл ~/.claude/skills/plan-panel/roles/scoper.md и следуй ему. ` +
  `Если файл недоступен — следуй этому inline spec:\n` +
  `- Available roles: scoper(always), architect(always), qa(always), judge(always), security(conditional), frontend, backend, data, ops\n` +
  `- В Phase A реализованы только: scoper, architect, qa, security, judge. Остальные пока недоступны — НЕ выбирай их.\n` +
  `- Security активируется если scope включает: backend, auth, data, api, infra, external, ИЛИ упомянуты credentials/tokens/passwords/PII в плане\n` +
  `- Complexity: low (1-3 шага), medium (4-10), high (10+ или security-sensitive)\n\n` +
  `=== ПЛАН ===\n${planText}\n=== END ===\n\n` +
  `=== PROJECT CONTEXT ===\n${projectSlug !== 'unknown-project' ? 'project_slug: ' + projectSlug : '(no project context)'}\n=== END ===\n\n` +
  `Верни JSON по схеме. selected_roles ДОЛЖЕН включать минимум: scoper, architect, qa, judge.`,
  { label: 'scoper', phase: 'Scope', model: 'haiku', schema: SCOPE_SCHEMA }
)

if (!scoper) {
  log('FATAL: scoper failed')
  return { error: 'scoper failed', verdict: 'UNCERTAIN', confidence: 0 }
}

// Fail-fast: если scoper не уверен в скоупе — не тратим Opus call впустую.
// Found in meta-self-review: panel.js не fail-fast'ил при confidence=0.
if ((scoper.confidence || 0) < 0.3 || (scoper.selected_roles || []).length < 3) {
  log(`✋ Fail-fast: scoper confidence=${scoper.confidence}, selected=${scoper.selected_roles?.length || 0}. Aborting без Opus call.`)
  return {
    error: 'low-confidence-scope',
    verdict: 'UNCERTAIN',
    confidence: scoper.confidence,
    scoper,
    user_action_required: 'Уточни план: добавь явные шаги имплементации, DoD, и категории работ (backend/frontend/data/etc). Если это спецификация существующего skill — переформулируй как "implement X" с шагами.',
  }
}

// Restrict to roles implemented in Phase A
const ALLOWED = ['scoper', 'architect', 'qa', 'security', 'judge']
const skipped = (scoper.selected_roles || []).filter(r => !ALLOWED.includes(r))
if (skipped.length) {
  log(`⚠️  Phase A roles not yet implemented, skipping: ${skipped.join(', ')} (judge должен это отметить как gap)`)
}
const selectedRoles = (scoper.selected_roles || [])
  .filter(r => ALLOWED.includes(r))
  .filter(r => r !== 'scoper' && r !== 'judge') // эти отдельно — не входят в parallel review phase

log(`Scope: ${scoper.scope_tags.join(', ')} · complexity: ${scoper.complexity}`)
log(`Selected roles for review: ${selectedRoles.join(', ')}`)
log(`Rationale: ${scoper.rationale}`)

// Lite mode — отбрасываем conditional роли, оставляем только architect+qa
let reviewRoles = selectedRoles
if (mode === 'lite') {
  reviewRoles = selectedRoles.filter(r => ['architect', 'qa'].includes(r))
  log(`Lite mode: roles cut to ${reviewRoles.join(', ')}`)
}

// ============= Phase 2: PARALLEL REVIEW =============
phase('Review')

const reviewPrompts = {
  architect: (plan) =>
    `Ты — architect из skill plan-panel. Прочитай role spec ~/.claude/skills/plan-panel/roles/architect.md и применяй 12-пунктовый checklist.\n\n` +
    `=== ПЛАН ===\n${plan}\n=== END ===\n\n` +
    `=== SCOPE (от scoper) ===\n${JSON.stringify(scoper, null, 2)}\n=== END ===\n\n` +
    `Верни JSON по схеме из _shared.md. Минимум 1 actionable suggestion если есть findings.`,
  qa: (plan) =>
    `Ты — qa из skill plan-panel. Прочитай role spec ~/.claude/skills/plan-panel/roles/qa.md и применяй 10-пунктовый checklist.\n\n` +
    `=== ПЛАН ===\n${plan}\n=== END ===\n\n` +
    `=== SCOPE ===\n${JSON.stringify(scoper, null, 2)}\n=== END ===\n\n` +
    `Фокус: acceptance criteria + edge cases + test strategy. НЕ дублируй security findings.\n` +
    `Верни JSON по схеме.`,
  security: (plan) =>
    `Ты — security из skill plan-panel. Прочитай role spec ~/.claude/skills/plan-panel/roles/security.md и применяй OWASP top-10 + secrets hygiene checklist.\n\n` +
    `=== ПЛАН ===\n${plan}\n=== END ===\n\n` +
    `=== SCOPE ===\n${JSON.stringify(scoper, null, 2)}\n=== END ===\n\n` +
    `КРИТИЧНО: если в плане упомянуты credentials/tokens/passwords/keys — проверь соответствие protocol из ~/.claude/skills/secrets/SKILL.md. Любое нарушение = critical.\n` +
    `Верни JSON по схеме (включая threat_model_summary).`,
}

const reviews = await parallel(
  reviewRoles.map((role) => async () => {
    const prompt = reviewPrompts[role]
    if (!prompt) {
      log(`⚠️ No prompt for role ${role}, skipping`)
      return null
    }
    return await agent(prompt(planText), {
      label: `review:${role}`,
      phase: 'Review',
      model: 'sonnet',
      schema: FINDINGS_SCHEMA,
    })
  })
)

const validReviews = reviews.filter(Boolean)
const failedRoleCount = reviewRoles.length - validReviews.length
log(`Got ${validReviews.length}/${reviewRoles.length} role reviews (${failedRoleCount} failed/null)`)

// Build attempted_vs_completed report для judge — он должен видеть полную картину
const reviewStatus = reviewRoles.map((role, i) => ({
  role,
  status: reviews[i] ? 'completed' : 'failed_or_null',
}))

// ============= Phase 3: JUDGE =============
phase('Synthesize')

const heavy = mode === 'heavy' || mode === 'standard'
const judge = await agent(
  `Ты — judge из skill plan-panel. Прочитай role spec ~/.claude/skills/plan-panel/roles/judge.md.\n\n` +
  `Mode: ${heavy ? 'HEAVY (cross-examination allowed)' : 'lite (no cross-exam)'}\n\n` +
  `=== EXECUTION REPORT ===\n` +
  `Attempted roles: ${reviewRoles.length} (${reviewRoles.join(', ')})\n` +
  `Completed: ${validReviews.length}\n` +
  `Failed/null: ${failedRoleCount}\n` +
  (skipped.length ? `Roles SKIPPED (not implemented in Phase A): ${skipped.join(', ')} — ОБЯЗАТЕЛЬНО упомяни их как gaps в твоём output.\n` : '') +
  `=== END EXECUTION REPORT ===\n\n` +
  `=== ПЛАН ===\n${planText}\n=== END ===\n\n` +
  `=== SCOPE (scoper output) ===\n${JSON.stringify(scoper, null, 2)}\n=== END ===\n\n` +
  `=== ROLE REVIEWS (${validReviews.length} ролей) ===\n${JSON.stringify(validReviews, null, 2)}\n=== END ===\n\n` +
  `Твои 3 задачи:\n` +
  `1. Conflicts — найди противоречия между ролями. ${heavy ? 'Имеешь право в conflicts указывать "cross_examined" если хочешь чтобы роль переоценила. Но в Phase A мы не делаем второй round — просто отметь конфликт и предложи resolution.' : 'Просто отметь конфликты, не делай cross-exam.'}\n` +
  `2. Gaps — что НИ ОДНА роль не покрыла? Особо смотри если security НЕ был активирован, но в плане есть user input / public endpoint / credentials.\n` +
  `3. Priority — собери все findings от всех ролей, рангируй по severity × impact, выдай top-5-10 actionable items.\n\n` +
  `Verdict matrix:\n` +
  `- PASS: нет critical, ≤2 warnings\n` +
  `- NEEDS-WORK: ≥1 critical ИЛИ ≥3 warnings\n` +
  `- FAIL: ≥2 critical от разных ролей + неразрешимые конфликты\n` +
  `- UNCERTAIN: confidence <0.5\n\n` +
  `Верни JSON по judge schema.`,
  { label: 'judge', phase: 'Synthesize', model: 'opus', schema: JUDGE_SCHEMA }
)

if (!judge) {
  log('FATAL: judge failed')
  return { error: 'judge failed', partial: { scoper, reviews: validReviews } }
}

log(`Claude judge: ${judge.verdict} (confidence ${judge.confidence})`)
log(`Priority actions: ${judge.priority_actions?.length || 0}`)
log(`Conflicts: ${judge.conflicts?.length || 0} · Gaps: ${judge.gaps?.length || 0}`)

// ============= Phase 4: CROSS-MODEL (только в ultra mode) =============
let crossModel = null
let metaJudge = null

if (mode === 'ultra') {
  phase('CrossModel')
  log('Запускаем GPT-5 + Gemini 2.5 Pro для outside opinion...')

  const META_SCHEMA = {
    type: 'object',
    required: ['final_verdict', 'agreement_summary', 'unique_concerns', 'final_priority_actions'],
    additionalProperties: true,
    properties: {
      final_verdict: { enum: ['PASS', 'FAIL', 'NEEDS-WORK', 'UNCERTAIN'] },
      confidence: { type: 'number' },
      agreement_summary: {
        type: 'object',
        properties: {
          all_three_agree_on: { type: 'array', items: { type: 'string' } },
          two_of_three_agree_on: { type: 'array', items: { type: 'string' } },
          unique_to_claude: { type: 'array', items: { type: 'string' } },
          unique_to_gpt: { type: 'array', items: { type: 'string' } },
          unique_to_gemini: { type: 'array', items: { type: 'string' } },
        },
      },
      unique_concerns: { type: 'array', items: { type: 'object' } },
      disputes: { type: 'array' },
      final_priority_actions: { type: 'array' },
      summary: { type: 'string' },
    },
  }

  const crossModelAgent = await agent(
    `Ты — meta-judge skill plan-panel в ultra mode. Запусти shell-script cross-model.sh который сделает параллельные API calls к GPT-5 и Gemini 2.5 Pro.\n\n` +
    `Шаги:\n` +
    `1. Создай temp dir через \`mktemp -d\` (НЕ хардкодь имя — workflow scripts не имеют Date.now). В нём:\n` +
    `   - plan.md (текст плана)\n` +
    `   - judge.md (markdown render Claude judge output)\n` +
    `   - reviews.json (JSON массив всех role reviews)\n` +
    `2. Запусти через Bash:\n` +
    `   bash ~/.claude/skills/plan-panel/lib/cross-model.sh <plan> <judge> <reviews>\n` +
    `   (скрипт self-wrap'ит через op run если env не выставлен)\n` +
    `3. Получи JSON output с {gpt, gemini, errors, usage}\n` +
    `4. Верни структурированный финальный анализ.\n\n` +
    `Plan text:\n${planText}\n\n` +
    `Claude judge output (для подачи в cross-models):\n${JSON.stringify(judge, null, 2)}\n\n` +
    `Role reviews:\n${JSON.stringify(validReviews, null, 2)}\n\n` +
    `После получения GPT и Gemini outputs синтезируй финал по схеме:\n` +
    `- Что подтвердили обе модели (high confidence findings)\n` +
    `- Что добавили — missing_dimensions от GPT и/или Gemini которых не было в Claude review\n` +
    `- Disputes — где GPT/Gemini не согласны с Claude severity\n` +
    `- Final priority action list (merged, dedupлено)\n` +
    `- Final verdict (может быть строже если GPT+Gemini подняли что-то critical что Claude пропустил)`,
    { label: 'cross-model-runner', phase: 'CrossModel', model: 'sonnet', schema: META_SCHEMA }
  )

  metaJudge = crossModelAgent
  log(`Meta-judge final: ${metaJudge?.final_verdict || 'unknown'}`)
}

// Generate review.md markdown (sole-author rule — каждая роль свою section)
function renderReviewMd() {
  const parts = []
  parts.push(`# Plan Review — ${timestamp}\n\nrun_id: \`${runId}\`  mode: \`${mode}\`  project: \`${projectSlug}\`\n`)
  parts.push(`## Scope (scoper)\n\n${scoper.rationale || ''}\n\n- tags: ${(scoper.scope_tags||[]).join(', ')}\n- complexity: ${scoper.complexity}\n- selected_roles: ${(scoper.selected_roles||[]).join(', ')}\n- confidence: ${scoper.confidence}\n`)
  for (const r of validReviews) {
    parts.push(`## ${r.role}\n\n**Verdict:** ${r.verdict} (confidence ${r.confidence})\n\n${r.summary || ''}\n\n### Findings\n\n${(r.findings||[]).map(f => `- **[${f.severity}]** ${f.area}: ${f.issue}\n  - Suggestion: ${f.suggestion}${f.ref ? `\n  - Ref: ${f.ref}` : ''}`).join('\n\n') || '(none)'}\n`)
  }
  return parts.join('\n')
}

function renderJudgeMd() {
  const j = judge
  const lines = []
  lines.push(`# Judge Synthesis — ${timestamp}\n\nrun_id: \`${runId}\`  verdict: **${j.verdict}**  confidence: ${j.confidence}\n`)
  lines.push(`## Summary\n\n${j.summary || ''}\n`)
  lines.push(`## Final reasoning\n\n${j.final_verdict_reasoning || ''}\n`)
  if (j.conflicts?.length) {
    lines.push(`## Conflicts\n\n${j.conflicts.map(c => `- Between ${(c.between||[]).join(' ↔ ')}: ${c.topic || c.summary}\n  - Resolution: ${c.resolution || '(unresolved)'}`).join('\n')}\n`)
  }
  if (j.gaps?.length) {
    lines.push(`## Gaps\n\n${j.gaps.map(g => typeof g === 'string' ? `- ${g}` : `- **${g.area || ''}**: ${g.issue || ''}`).join('\n')}\n`)
  }
  if (j.priority_actions?.length) {
    lines.push(`## Priority actions\n\n${j.priority_actions.map(a => `${a.rank ? a.rank + '. ' : '- '}**[${a.severity}]** ${a.action}${a.owner_role ? ` _(owner: ${a.owner_role})_` : ''}${a.estimated_effort ? ` _(${a.estimated_effort})_` : ''}`).join('\n')}\n`)
  }
  return lines.join('\n')
}

function renderMetaJudgeMd() {
  if (!metaJudge) return null
  const lines = []
  lines.push(`# Meta-Judge (Claude + GPT-5 + Gemini 2.5 Pro) — ${timestamp}\n\nrun_id: \`${runId}\`  final_verdict: **${metaJudge.final_verdict}**  confidence: ${metaJudge.confidence}\n`)
  lines.push(`## Summary\n\n${metaJudge.summary || ''}\n`)
  const a = metaJudge.agreement_summary || {}
  if (a.all_three_agree_on?.length) lines.push(`## Все 3 согласны\n\n${a.all_three_agree_on.map(x => `- ${x}`).join('\n')}\n`)
  if (a.two_of_three_agree_on?.length) lines.push(`## 2 из 3 согласны\n\n${a.two_of_three_agree_on.map(x => `- ${x}`).join('\n')}\n`)
  if (a.unique_to_gpt?.length) lines.push(`## Уникально от GPT-5\n\n${a.unique_to_gpt.map(x => `- ${x}`).join('\n')}\n`)
  if (a.unique_to_gemini?.length) lines.push(`## Уникально от Gemini\n\n${a.unique_to_gemini.map(x => `- ${x}`).join('\n')}\n`)
  if (a.unique_to_claude?.length) lines.push(`## Уникально от Claude\n\n${a.unique_to_claude.map(x => `- ${x}`).join('\n')}\n`)
  if (metaJudge.final_priority_actions?.length) {
    lines.push(`## Final priority actions\n\n${metaJudge.final_priority_actions.map((a, i) => `${a.rank || i+1}. **[${a.severity || '?'}]** ${a.action || a.issue || ''}`).join('\n')}\n`)
  }
  return lines.join('\n')
}

const metadata = {
  run_id: runId,
  timestamp,
  mode,
  project_slug: projectSlug,
  project_dir: projectDir,
  central_dir: centralDir,
  cwd,
  selected_roles: ['scoper', ...reviewRoles, 'judge', ...(mode === 'ultra' ? ['meta-judge'] : [])],
  skipped_roles_not_implemented: skipped,
  failed_role_count: failedRoleCount,
  review_status: reviewStatus,
  cross_model_used: mode === 'ultra',
  verdict: metaJudge?.final_verdict || judge.verdict,
  confidence: metaJudge?.confidence || judge.confidence,
}

return {
  // Workflow возвращает structured payload. Caller (/plan-review) записывает на disk
  // через Write/Bash tools — workflow scripts не имеют прямого FS access.
  artifacts: {
    'plan.md': planText,
    'scope.json': JSON.stringify(scoper, null, 2),
    'reviews.json': JSON.stringify(validReviews, null, 2),
    'review.md': renderReviewMd(),
    'judge.json': JSON.stringify(judge, null, 2),
    'judge.md': renderJudgeMd(),
    ...(metaJudge ? {
      'meta-judge.json': JSON.stringify(metaJudge, null, 2),
      'meta-judge.md': renderMetaJudgeMd(),
    } : {}),
    'metadata.json': JSON.stringify(metadata, null, 2),
  },
  // Структурированный summary (для quick display в чате):
  run_id: runId,
  timestamp,
  project_dir: projectDir,
  central_dir: centralDir,
  scoper,
  reviews: validReviews,
  judge,
  meta_judge: metaJudge,
  verdict: metaJudge?.final_verdict || judge.verdict,
  confidence: metaJudge?.confidence || judge.confidence,
  mode,
  selected_roles: ['scoper', ...reviewRoles, 'judge', ...(mode === 'ultra' ? ['meta-judge'] : [])],
  skipped_roles_not_implemented: skipped,
  failed_role_count: failedRoleCount,
  cross_model_used: mode === 'ultra',
}
