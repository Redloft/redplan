// finalize.js — Stage 2 / Часть B: панель код-ревью по git diff (DESIGN /finalize).
// Вход — УЖЕ stripped diff + changed_files + stabilize_report (snapshot+stabilize делает
// сессия детерминированно через Bash; см. finalize/SKILL.md). Здесь: scope→roles→judge.
// Переиспользует роли plan-panel в review_mode=code (overlay из plan-panel/_shared.md §10.2,
// НЕ дублируя role-файлы). Judge: SHIP / FIX-FIRST / NEEDS-WORK, stable-aware.
//
// Args: diff_text, changed_files[], stabilize_report{stable,rounds,remaining_failures,fixer_warnings},
//       gates_found(bool), mode, project_slug, cwd, project_dir, timestamp, run_id
// Возвращает artifacts{} + summary (как panel.js; caller пишет на диск).

export const meta = {
  name: 'finalize',
  description: 'Код-ревью по git diff: scope → роли в review_mode=code → judge (SHIP/FIX-FIRST/NEEDS-WORK), учитывает stabilize-report',
  phases: [
    { title: 'Scope', detail: 'Haiku scoper по содержимому diff выбирает роли' },
    { title: 'Review', detail: 'роли ревьюят diff (review_mode=code) параллельно' },
    { title: 'Judge', detail: 'Opus судья: verdict + stable-aware (не SHIP если нестабильно)' },
  ],
}

const A = (typeof args === 'string' ? (() => { try { return JSON.parse(args) } catch { return {} } })() : args) || {}
let diffText = A.diff_text || ''
if (!diffText && A.diff_path) {
  // Fallback: caller передал путь к файлу вместо содержимого (для больших diff'ов > ~50KB через args
  // удобнее так). Читаем через scoper-агента (у workflow нет прямого fs API).
  const readResult = await agent(`Прочитай файл ${A.diff_path} целиком и верни СЫРОЕ содержимое БЕЗ обёртки и комментариев. Если файл пустой — верни пустую строку.`, { label: 'read-diff', phase: 'Scope' })
  diffText = (readResult || '').trim()
}
let changedFiles = A.changed_files || []
if ((!changedFiles || changedFiles.length === 0) && A.changed_files_path) {
  const cfRaw = await agent(`Прочитай файл ${A.changed_files_path} и верни список путей файлов (по одному на строку), без комментариев.`, { label: 'read-changed-files', phase: 'Scope' })
  changedFiles = (cfRaw || '').split('\n').map(s => s.trim()).filter(Boolean)
}
const stab = A.stabilize_report || { stable: 'unknown', rounds: 0, remaining_failures: [], fixer_warnings: [] }
const gatesFound = A.gates_found !== false
const projectSlug = A.project_slug || 'unknown-project'
const cwd = A.cwd || ''
const projectDir = A.project_dir || ''
const timestamp = A.timestamp || 'now'
const runId = A.run_id || 'unknown-run-id'
const mode = A.mode || 'standard'

if (!diffText.trim()) return { error: 'empty-diff', verdict: 'UNCERTAIN', reason: 'нечего финализировать (пустой diff)' }

const OVERLAY = '~/.claude/skills/plan-panel/_shared.md §10.2 (review_mode=code)'
const ROLES_DIR = '~/.claude/skills/plan-panel/roles'

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
const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['role', 'verdict', 'confidence', 'findings', 'summary', 'self_check_passed'],
  additionalProperties: true,
  properties: {
    role: { type: 'string' },
    verdict: { enum: ['PASS', 'FAIL', 'UNCERTAIN', 'NEEDS-WORK'] },
    confidence: { type: 'number' },
    findings: { type: 'array', items: {
      type: 'object', required: ['severity', 'area', 'issue', 'suggestion'], additionalProperties: true,
      properties: { severity: { enum: ['critical', 'warning', 'suggestion'] }, area: { type: 'string' }, issue: { type: 'string' }, suggestion: { type: 'string' }, ref: { type: 'string' } },
    } },
    summary: { type: 'string' },
    self_check_passed: { type: 'boolean' },
    checked_files: { type: 'array', items: { type: 'string' } },
  },
}
const JUDGE_SCHEMA = {
  type: 'object',
  required: ['verdict', 'confidence', 'priority_actions', 'summary', 'final_verdict_reasoning'],
  additionalProperties: true,
  properties: {
    verdict: { enum: ['SHIP', 'FIX-FIRST', 'NEEDS-WORK'] },
    confidence: { type: 'number' },
    findings: { type: 'array' },
    conflicts: { type: 'array' },
    gaps: { type: 'array' },
    priority_actions: { type: 'array', items: {
      type: 'object', required: ['rank', 'severity', 'action'], additionalProperties: true,
      properties: { rank: { type: 'number' }, severity: { enum: ['critical', 'warning', 'suggestion'] }, action: { type: 'string' } },
    } },
    summary: { type: 'string' },
    final_verdict_reasoning: { type: 'string' },
  },
}

const ALLOWED = ['architect', 'qa', 'security', 'frontend', 'backend', 'data', 'ops']

// ===== Chunking (DESIGN §chunk): большой diff → группы по directory-prefix =====
const N_FILES = 200          // порог по числу файлов
const MAX_CHARS = 80000      // ~20k токенов/роль — порог по объёму
const M_PER_CHUNK = 100      // макс файлов в группе

// Разбить diffText на per-file блоки (git diff: каждый файл начинается с "diff --git")
function splitDiffByFile(text) {
  const parts = text.split(/(?=^diff --git )/m).filter(s => s.trim())
  return parts.map(block => {
    const m = block.match(/^diff --git a\/.+? b\/(.+)$/m) || block.match(/^\+\+\+ b\/(.+)$/m)
    return { path: m ? m[1].trim() : '(unknown)', block }
  })
}
// Сгруппировать файлы по top-dir prefix, упаковать в чанки ≤ M файлов (одна директория не дробится без нужды)
function groupChunks(fileBlocks) {
  const byDir = new Map()
  for (const fb of fileBlocks) {
    const dir = fb.path.includes('/') ? fb.path.split('/')[0] : '.'
    if (!byDir.has(dir)) byDir.set(dir, [])
    byDir.get(dir).push(fb)
  }
  const chunks = []
  let cur = []
  for (const [, files] of byDir) {
    for (const f of files) {
      cur.push(f)
      if (cur.length >= M_PER_CHUNK) { chunks.push(cur); cur = [] }
    }
  }
  if (cur.length) chunks.push(cur)
  return chunks
}

const needChunk = changedFiles.length > N_FILES || diffText.length > MAX_CHARS
let chunks = [null] // null = единый diff (без дробления)
if (needChunk) {
  const fileBlocks = splitDiffByFile(diffText)
  chunks = groupChunks(fileBlocks)
  log(`⚠️  большой diff (${changedFiles.length} файлов / ${diffText.length} симв) → дроблю на ${chunks.length} групп по ≤${M_PER_CHUNK} файлов (no silent cap)`)
}

const buildEnvelope = (chunk) => {
  if (!chunk) return `=== CHANGED FILES (${changedFiles.length}) ===\n${changedFiles.join('\n')}\n\n=== GIT DIFF (already secrets-stripped) ===\n${diffText}\n=== END DIFF ===`
  const files = chunk.map(f => f.path)
  return `=== CHUNK: CHANGED FILES (${files.length}) ===\n${files.join('\n')}\n\n=== GIT DIFF (chunk, already secrets-stripped) ===\n${chunk.map(f => f.block).join('\n')}\n=== END DIFF ===`
}
// scoper view: при дроблении не шлём весь diff в haiku — список файлов + первый чанк
const scoperEnvelope = needChunk
  ? `=== CHANGED FILES (${changedFiles.length}, diff большой — показан первый фрагмент) ===\n${changedFiles.join('\n')}\n\n=== DIFF SAMPLE ===\n${(chunks[0] || []).map(f => f.block).join('\n').slice(0, 15000)}\n=== END ===`
  : buildEnvelope(null)

log(`/finalize · ${changedFiles.length} files · stable=${stab.stable} · mode=${mode}${needChunk ? ` · chunks=${chunks.length}` : ''}`)

// ===== Phase 1: SCOPE (по diff) =====
phase('Scope')
const scoper = await agent(
  `Ты — scoper из plan-panel, но scope считаешь по СОДЕРЖИМОМУ git diff (какие подсистемы тронуты), не по плану.\n` +
  `Прочитай ${ROLES_DIR}/scoper.md для правил активации ролей. Доступные роли: ${ALLOWED.join(', ')} (+ judge всегда).\n` +
  `Выбери роли по тому, что реально в diff (например изменения в .sql/migration → data; auth/credential/token → security; api/server → backend; .tsx/css → frontend; CI/Dockerfile/deploy → ops).\n` +
  `selected_roles ДОЛЖЕН содержать ≥3 (минимум architect, qa + релевантные).\n\n${scoperEnvelope}\n\nВерни JSON по схеме.`,
  { label: 'scoper', phase: 'Scope', model: 'haiku', schema: SCOPE_SCHEMA }
)
if (!scoper) return { error: 'scoper-failed', verdict: 'UNCERTAIN' }
const selected = (scoper.selected_roles || []).filter(r => ALLOWED.includes(r))
if (selected.length < 2) selected.push('architect', 'qa')
const reviewRoles = [...new Set(selected.length >= 3 ? selected : [...selected, 'architect', 'qa'])].filter(r => ALLOWED.includes(r))
log(`Scope: ${(scoper.scope_tags || []).join(', ')} · roles: ${reviewRoles.join(', ')}`)

// ===== Phase 2: REVIEW (review_mode=code) =====
phase('Review')
const reviewPrompt = (role, envelope, chunkNote) =>
  `Ты — ${role} из plan-panel в РЕЖИМЕ review_mode=code. Прочитай ${ROLES_DIR}/${role}.md (твой базовый чек-лист) И применяй overlay ${OVERLAY}:\n` +
  `— оцениваешь РЕАЛИЗОВАННЫЕ изменения (git diff), а не план;\n` +
  `— ищешь баги/регрессии/нарушенные инварианты/тех-долг В КОДЕ;\n` +
  `— каждый finding.ref ОБЯЗАН указывать путь:строку из diff, без literal-значений секретов;\n` +
  `— заполни checked_files[] (какие файлы реально просмотрел; при нехватке контекста используй Read/codegraph по ${cwd}).\n` +
  `${chunkNote}\n${envelope}\n\nВерни JSON по FINDINGS_SCHEMA.`

// worst-verdict для мёржа чанков одной роли
const VRANK = { FAIL: 3, 'NEEDS-WORK': 2, UNCERTAIN: 1, PASS: 0 }
const worst = (a, b) => (VRANK[a] ?? 1) >= (VRANK[b] ?? 1) ? a : b

// плоский список задач role×chunk → параллельно, потом мёрж по роли
const tasks = []
reviewRoles.forEach(role => chunks.forEach((chunk, ci) =>
  tasks.push({ role, chunk, ci, note: chunk ? `\n[ГРУППА ${ci + 1}/${chunks.length} — оцени только файлы этой группы]\n` : '' })))

const rawResults = (await parallel(tasks.map(t => () =>
  agent(reviewPrompt(t.role, buildEnvelope(t.chunk), t.note),
    { label: `review:${t.role}${t.chunk ? `#${t.ci + 1}` : ''}`, phase: 'Review', model: 'sonnet', schema: FINDINGS_SCHEMA }
  ).then(r => r ? { ...r, role: t.role } : null)
))).filter(Boolean)

// мёрж per-role (findings конкатенируются, verdict = worst, checked_files объединяются)
const byRole = new Map()
for (const r of rawResults) {
  if (!byRole.has(r.role)) { byRole.set(r.role, { role: r.role, verdict: r.verdict, confidence: r.confidence, findings: [...(r.findings || [])], summary: r.summary, self_check_passed: r.self_check_passed, checked_files: [...(r.checked_files || [])] }) }
  else {
    const m = byRole.get(r.role)
    m.verdict = worst(m.verdict, r.verdict)
    m.confidence = Math.min(m.confidence ?? 1, r.confidence ?? 1)
    m.findings.push(...(r.findings || []))
    m.checked_files = [...new Set([...m.checked_files, ...(r.checked_files || [])])]
    m.summary = `${m.summary} | ${r.summary}`
    m.self_check_passed = m.self_check_passed && r.self_check_passed
  }
}
const reviews = [...byRole.values()]

const failedRoleCount = reviewRoles.length - reviews.length
log(`Reviews: ${reviews.length}/${reviewRoles.length} ролей ответили${needChunk ? ` (${tasks.length} role×chunk задач)` : ''}`)

// ===== Phase 3: JUDGE (stable-aware) =====
phase('Judge')
const judge = await agent(
  `Ты — judge из plan-panel для /finalize. Синтезируй ревью кода, найди конфликты/gaps, выдай priority-ranked action list.\n` +
  `Прочитай ${ROLES_DIR}/judge.md. Verdict-словарь для кода: SHIP (можно мерджить) / FIX-FIRST (есть critical, чинить до мерджа) / NEEDS-WORK.\n\n` +
  `ЖЁСТКИЕ ПРАВИЛА:\n` +
  `— stabilize stable="${stab.stable}". Если stable=false ИЛИ stable=unknown → verdict НЕ может быть SHIP.\n` +
  `— fixer_warnings (подавление тестов/линтера) затрагивающие changed_files → опусти verdict минимум до NEEDS-WORK и упомяни.\n` +
  `${!gatesFound ? '— гейты не обнаружены → отметь gap "нет автоматических проверок", но не понижай verdict только за это.\n' : ''}` +
  `— если remaining_failures непустой — это critical, FIX-FIRST.\n\n` +
  `=== STABILIZE REPORT ===\n${JSON.stringify(stab, null, 2)}\n=== END ===\n\n` +
  `=== ROLE REVIEWS ===\n${JSON.stringify(reviews.map(r => ({ role: r.role, verdict: r.verdict, findings: r.findings, summary: r.summary })), null, 2)}\n=== END ===\n\n` +
  `${buildEnvelope(null)}\n\nВерни JSON по JUDGE_SCHEMA. final_verdict_reasoning объясни явно.`,
  { label: 'judge', phase: 'Judge', model: 'fable', schema: JUDGE_SCHEMA }
)
if (!judge) return { error: 'judge-failed', verdict: 'UNCERTAIN', reviews }

// Подстраховка инварианта на оркестраторе (не только в промпте судьи):
let verdict = judge.verdict
if ((stab.stable === false || stab.stable === 'unknown') && verdict === 'SHIP') {
  verdict = 'FIX-FIRST'
  log(`⚠️  override: stable=${stab.stable} → verdict SHIP→FIX-FIRST (enforced)`)
}

const renderReviewMd = () => reviews.map(r =>
  `## ${r.role}\n\n**verdict**: ${r.verdict} · confidence: ${r.confidence}\n\n` +
  (r.findings || []).map(f => `- **[${f.severity}]** ${f.area}: ${f.issue}\n  - → ${f.suggestion}${f.ref ? ` (\`${f.ref}\`)` : ''}`).join('\n') +
  `\n\n_${r.summary}_\n`).join('\n')

const renderJudgeMd = () =>
  `# Finalize — ${timestamp}\n\nrun_id: \`${runId}\`  verdict: **${verdict}**  confidence: ${judge.confidence}  stable: \`${stab.stable}\`\n\n` +
  `${judge.final_verdict_reasoning}\n\n## Priority actions\n\n` +
  (judge.priority_actions || []).map(a => `${a.rank}. **[${a.severity}]** ${a.action}`).join('\n') +
  ((judge.gaps || []).length ? `\n\n## Gaps\n\n${judge.gaps.map(g => `- ${typeof g === 'string' ? g : (g.area || JSON.stringify(g))}`).join('\n')}` : '')

const metadata = {
  run_id: runId, timestamp, mode, project_slug: projectSlug, cwd, project_dir: projectDir,
  verdict, confidence: judge.confidence, stable: stab.stable, stabilize_rounds: stab.rounds,
  remaining_failures: stab.remaining_failures || [], fixer_warnings: stab.fixer_warnings || [],
  changed_files: changedFiles, selected_roles: ['scoper', ...reviewRoles, 'judge'],
  failed_role_count: failedRoleCount, gates_found: gatesFound,
}

return {
  artifacts: {
    'scope.json': JSON.stringify(scoper, null, 2),
    'reviews.json': JSON.stringify(reviews, null, 2),
    'review.md': renderReviewMd(),
    'judge.json': JSON.stringify({ ...judge, verdict }, null, 2),
    'judge.md': renderJudgeMd(),
    'stabilize.json': JSON.stringify(stab, null, 2),
    'metadata.json': JSON.stringify(metadata, null, 2),
  },
  verdict, confidence: judge.confidence, stable: stab.stable,
  judge: { ...judge, verdict }, reviews, scoper,
  selected_roles: reviewRoles, failed_role_count: failedRoleCount, run_id: runId,
}
