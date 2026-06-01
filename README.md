# redplan

> Multi-role plan verification skill for [Claude Code](https://claude.com/claude-code).
> Spawns a panel of expert subagents (architect, qa, security, judge…) with strict checklist-driven protocols. Synthesizes findings into a priority-ranked action list. Optional cross-model verify via GPT-5 + Gemini 2.5 Pro for critical plans.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Claude Code Skill](https://img.shields.io/badge/Claude%20Code-Skill-orange)
![Status](https://img.shields.io/badge/status-beta-yellow)

---

## What problem does it solve

When you ask Claude to build something non-trivial, the **plan** is where 80% of mistakes are baked in: missing acceptance criteria, security vectors no one thought of, broken assumptions, premature abstractions. One LLM reading its own plan rarely catches these — there's no adversarial pressure.

`redplan` makes this adversarial: **multiple expert roles** review the plan in parallel with **structured protocols** (checklist + severity rubric + JSON schema), a **judge** synthesizes their findings with conflict resolution, and optionally a **second-opinion pass** through GPT-5 and Gemini 2.5 Pro finds blind spots specific to Claude.

Real example (verified on our own plan): the panel found a forward dependency in the architecture, a missing error contract, and a supply-chain vector through `.env` token storage — none of which we noticed when writing the plan.

---

## Quick start

### Install (1 command, ~30 sec)

```bash
curl -fsSL https://raw.githubusercontent.com/Redloft/redplan/main/install.sh | bash
```

The installer:
1. Checks deps (`git`, `curl`, `jq`, `node ≥18`, `python3`)
2. Clones to `~/.claude/skills/plan-panel/`
3. Copies `/plan-review` slash-command to `~/.claude/commands/`
4. Runs `doctor.sh` to report optional feature status

Alternative — manual install:
```bash
git clone https://github.com/Redloft/redplan ~/.claude/skills/plan-panel
cp ~/.claude/skills/plan-panel/commands/plan-review.md ~/.claude/commands/
```

You can also paste this URL in any Claude Code session — Claude will read this README and walk you through install:
```
Install this skill: https://github.com/Redloft/redplan
```

### Diagnose

After install, run doctor anytime:
```bash
bash ~/.claude/skills/plan-panel/lib/doctor.sh
```

It checks: core deps, install integrity, persistence permissions, optional `--ultra` mode setup (env vars or 1Password CLI).

### Update

```bash
git -C ~/.claude/skills/plan-panel pull
cp ~/.claude/skills/plan-panel/commands/plan-review.md ~/.claude/commands/
```

Or just re-run `install.sh` — idempotent.

### Uninstall

```bash
rm -rf ~/.claude/skills/plan-panel ~/.claude/commands/plan-review.md
```

### Use

In any Claude Code session:

```
/plan-review <your plan as markdown text>
```

Modes — append flag at end:
- `--lite` — quick check (3 roles)
- `--heavy` — judge cross-examines conflicts
- `--ultra` — adds GPT-5 + Gemini 2.5 Pro cross-verify (requires API keys, see below)

### Optional: enable `--ultra` mode (cross-model verify)

Ultra mode passes plan + Claude's panel review to GPT-5 + Gemini 2.5 Pro independently, then synthesizes 3 perspectives. Useful for critical plans.

**Option A: env vars** (simplest)
```bash
export OPENAI_API_KEY="sk-..."
export GEMINI_API_KEY="AIza..."
# Add to ~/.zshrc or ~/.bashrc to persist
```

**Option B: 1Password CLI** (recommended for shared machines)

If you have `op` CLI installed and items named `OpenAI` and `Gemini` in your default vault (with `credential` field) — `lib/cross-model.sh` will auto-wrap calls via `op run`. No env vars needed in shell.

**Optional SOCKS5 proxy** (if Gemini is geo-blocked in your country):
```bash
export GEMINI_PROXY="socks5://127.0.0.1:1080"
```

Verify ultra mode setup:
```bash
bash ~/.claude/skills/plan-panel/lib/doctor.sh
# Look for: "Ultra mode (cross-model verify): ready"
```

The skill auto-detects scope (backend / frontend / data / security / ops), picks 3-7 relevant roles, runs them in parallel, and gives you:
- A priority-ranked action list
- Conflict resolution between expert views
- Gap analysis (what NO role covered)
- Final verdict: `PASS / NEEDS-WORK / FAIL`

All artifacts saved to `<cwd>/.plan-panel/<timestamp>-<slug>/`.

---

## How it works

```
plan → SCOPE (Haiku scoper, ~$0.005)
        └→ classifies tags, picks 3-7 relevant roles
       ↓
       PARALLEL REVIEW (Sonnet, all activated roles)
        └→ each writes structured JSON: {verdict, confidence, findings[], summary}
        └→ sole-author rule: each role owns its review.md section
       ↓
       SYNTHESIZE (Opus judge)
        └→ finds conflicts between roles, cross-examines (heavy mode)
        └→ finds gaps (what NO role covered)
        └→ priority-ranked action list with severity × impact × confidence
       ↓
       [ultra mode] CROSS-MODEL VERIFY
        └→ GPT-5 + Gemini 2.5 Pro independently review plan + Claude judge
        └→ meta-judge synthesizes 3 perspectives, highlights agreement matrix
       ↓
       artifacts in <cwd>/.plan-panel/<ts>-<slug>/
```

---

## Roles

Phase A (current) implements 5 of 9 planned roles:

| Role | Model | When activated | Checklist |
|---|---|---|---|
| **scoper** | Haiku | Always — entry point | Classifies scope_tags, picks roles, returns complexity |
| **architect** | Sonnet | Always | 12 points: decomposition, dependencies, coupling, missing layers, premature abstraction, reversibility, achievability, contracts, state, versioning |
| **qa** | Sonnet | Always | 10 points: acceptance criteria, edge cases, test strategy, observability, regression, performance criteria, failure modes, DoD |
| **security** | Sonnet | When scope includes backend/auth/data/api/credentials | OWASP top-10 + secrets hygiene + threat model |
| **judge** | Opus | Always | Synthesizes + cross-examines conflicts + finds gaps + priority actions |

Phase B (roadmap) adds: `frontend`, `backend`, `data`, `ops` as conditional roles. See `docs/roadmap.md`.

---

## Modes

| Mode | Roles | Cost (if API) | Cost (if Max subscription) | When |
|---|---|---|---|---|
| `--lite` | scoper + architect + qa + judge | ~$0.20 | $0 (counts vs usage limit) | Quick sanity check |
| `standard` (default) | + relevant conditional roles | ~$0.70-1.50 | $0 | Default for non-trivial plans |
| `--heavy` | + cross-examination of conflicts | ~$1.50-2.50 | $0 | When you want judge to challenge role conflicts |
| `--ultra` | standard + **GPT-5 + Gemini 2.5 Pro cross-verify** | ~$0.70 + **$0.10-0.20 API** | **$0 + $0.10-0.20 API** | Critical plans where 3-model agreement matters |

Ultra mode requires API keys (see Cross-model setup below). Other modes work purely through your Claude Code subscription.

---

## Output

In chat, you get a summary like:
```
🎯 Verdict: NEEDS-WORK (confidence 0.88)

Top priority actions:
  #1 [critical] Add per-step "Done when:" acceptance criteria (qa)
  #2 [critical] Path traversal: validate `role` as enum before fs path use (judge synthesis)
  #3 [critical] Slack webhook fire-and-forget — endpoint returns 200 before Slack (architect)
  #4 [warning] Define response contract: 200/400/401/429/500 + error schema (architect)
  #5 [warning] Lock the middleware order: rate-limit → auth → validate → save → async slack

⚠️ Gaps (no role covered):
  • Rate-limiting behavior under cluster deploy (mentioned by ops scope but ops not in Phase A)

📁 Full artifacts: .plan-panel/2026-06-01_12-30-15-feedback-endpoint/
```

Full artifacts dir:
- `plan.md` — original plan
- `scope.json` — scoper output
- `review.md` — sectioned by role (sole-author)
- `judge.md` — synthesis
- `metadata.json` — run_id, models, tokens, duration

In `--ultra` mode, additionally:
- `meta-judge.md` — synthesis of Claude + GPT-5 + Gemini perspectives with agreement matrix

---

## Cross-model setup (optional, only for `--ultra`)

The ultra mode passes the plan + Claude's panel review to **GPT-5** and **Gemini 2.5 Pro** independently, then meta-judges all 3 perspectives. This catches blind spots specific to one model family.

### Required: API keys

```bash
export OPENAI_API_KEY="sk-..."
export GEMINI_API_KEY="AIza..."
```

Or via 1Password CLI (recommended for shared dev machines):
```bash
# lib/cross-model.sh self-wraps via `op run` if env vars are unset
# It expects items named OpenAI and Gemini in your default vault by default.
# Customize via lib/cross-model.sh op:// references.
```

### Optional: SOCKS5 proxy for Gemini

If you're behind a geo-block (e.g. Gemini doesn't work from your country), set:
```bash
export GEMINI_PROXY="socks5://127.0.0.1:1080"
```

`lib/cross-model.sh` will route only Gemini calls through this proxy via `curl --socks5-hostname`.

### Cost

| Provider | Model | ~Tokens per call | ~Cost per call |
|---|---|---|---|
| OpenAI | gpt-5 | 5k input + 3k output | ~$0.08 |
| Google | gemini-2.5-pro | 5k input + 1.5k output | ~$0.014 |
| **Total** | — | — | **~$0.10 per ultra run** |

---

## Persistence

Artifacts saved to two locations:

| Location | Role | Path |
|---|---|---|
| **Canonical** (source of truth) | Per-project | `<cwd>/.plan-panel/<ts>-<slug>/` |
| **Mirror** (best-effort) | Cross-project | `$PLAN_PANEL_CENTRAL/<project>/<ts>-<slug>/` |

Central root resolution (see `lib/persist.sh`):
1. `$PLAN_PANEL_CENTRAL` env (recommended)
2. `$CLAUDECORE_PATH/plan-panel/` (legacy fallback)
3. `~/.plan-panel-central/` (default)

Add `.plan-panel/` to your project's `.gitignore` unless you want artifacts tracked.

---

## Architecture decisions

| Decision | Why |
|---|---|
| **Protocol-driven**, not personality | Each role has a numbered checklist (8-12 points), not "vibe: enthusiastic". Findings are parseable, comparable, regressible. |
| **Scope-driven activation** | Scoper picks 3-7 relevant roles, not "always 50". Hardcoded rules — no ML, transparent, user-overridable. |
| **Model tier routing** | Haiku for scope (cheap), Sonnet for review, Opus for judge. 5-10x cost reduction vs "all Opus". |
| **Sole-author rule** | Each role owns one section of `review.md`. No merge conflicts, parseable for self-improvement loop. |
| **Cross-model in ultra only** | Default modes work purely through your Claude subscription. API spend is opt-in. |
| **Workflow tool orchestration** | Deterministic phase routing, parallel role execution, structured output validation. |

Inspired by patterns from [aws-samples/sample-claude-code-agent-team](https://github.com/aws-samples/sample-claude-code-agent-team) (sole-author rule), [catlog22/Claude-Code-Workflow](https://github.com/catlog22/Claude-Code-Workflow) (solidify pattern, planned for Phase B), and [wshobson/agents](https://github.com/wshobson/agents) (model tier routing).

---

## Roadmap

**Phase A — MVP** ✅ (current)
- 5 roles: scoper, architect, qa, security, judge
- 3-phase Workflow orchestrator
- Dual persistence
- Ultra mode with cross-model verify

**Phase B — Full panel + self-improvement** (next)
- 4 more conditional roles: frontend, backend, data, ops
- `/panel-feedback` — capture which findings were useful/noise per role
- `/panel-solidify` — meta-agent reviews accumulated feedback → proposes diffs to role prompts → user approves via signed channel (HMAC + chat_id whitelist for TG integration)
- Versioned role prompts (`roles/<role>.history/`)
- Golden dataset regression check before applying prompt changes

**Phase C — Production polish**
- Structured JSONL run logs with correlation_id
- Concurrent run lock-file
- Russian-language scoper triggers
- `lib/run-golden.sh` real-comparison runner
- Cost/budget enforcement at runtime

---

## Contributing

PRs welcome. See `CONTRIBUTING.md`.

Bug reports: please include the `metadata.json` from the artifacts dir (it has `run_id`, model versions, token counts).

---

## License

MIT — see `LICENSE`.

---

## Acknowledgments

This skill was itself reviewed by the skill (meta-test 🐍🐍). The panel found 11 critical issues in its own architecture across Claude + GPT-5 + Gemini Pro, which are tracked in the roadmap. Cross-model verification proved its worth on the first real plan.

If you find this useful, ⭐ the repo — it helps signal to others in the Claude Code community.
