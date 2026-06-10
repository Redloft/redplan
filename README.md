# redplan

> Multi-role **plan verification** + **code-review** skills for [Claude Code](https://claude.com/claude-code).
> A panel of expert subagents (architect, qa, security, backend, ops, data, frontend, judge) reviews your **plan** *before* you build — or your **diff** *before* you merge — with strict checklist-driven protocols and a synthesizing judge. Optional cross-model second opinion via GPT-5 + Gemini 2.5 Pro.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Claude Code Skill](https://img.shields.io/badge/Claude%20Code-Skill-orange)

This repo ships **two sibling skills** that share one role engine:

| Skill | Input | Use | Verdict |
|---|---|---|---|
| **plan-panel** (`/plan-review`) | a plan / RFC / task | catch design mistakes *before* coding | priority-ranked action list |
| **finalize** (`/finalize`) | the working **git diff** | stabilize (typecheck/lint/test) + review *before* merge | SHIP / FIX-FIRST / NEEDS-WORK |

---

## What problem does it solve

The **plan** is where ~80% of mistakes are baked in (missing acceptance criteria, security vectors, broken assumptions, premature abstractions), and the **diff** is where the rest sneak in. One LLM reading its own work rarely catches these — there's no adversarial pressure.

redplan makes it adversarial: **multiple expert roles** review in parallel with **structured protocols** (checklist + severity rubric + JSON schema), a **judge** synthesizes with conflict resolution, and optionally a **second-opinion pass** through other models finds Claude-specific blind spots. `finalize` reuses the same roles in `review_mode=code` against a real diff.

---

## Quick start

### Install (1 command — installs both skills)

```bash
curl -fsSL https://raw.githubusercontent.com/Redloft/redplan/main/install.sh | bash
```

The installer checks deps (`git`, `curl`, `jq`, `node ≥18`, `python3`), copies
`plan-panel/` → `~/.claude/skills/plan-panel`, `finalize/` → `~/.claude/skills/finalize`
(sharing `plan-panel/lib` via relative symlinks), installs the slash-commands, and runs `doctor.sh`.

Manual install:
```bash
git clone https://github.com/Redloft/redplan /tmp/redplan
cp -R /tmp/redplan/plan-panel  ~/.claude/skills/plan-panel
cp -R /tmp/redplan/finalize    ~/.claude/skills/finalize
cp /tmp/redplan/plan-panel/commands/*.md ~/.claude/commands/
```

Or paste in any Claude Code session — Claude reads this README and walks you through:
```
Install this skill: https://github.com/Redloft/redplan
```

### Use

```
/plan-review <your plan as text>      # verify a plan
/plan-review --from-task <task>       # draft a plan, then loop-review it (experimental)
/finalize                             # stabilize + review the current working diff
/finalize --since <ref>               # review a diff against a ref
```

### Diagnose / update / uninstall

```bash
bash ~/.claude/skills/plan-panel/lib/doctor.sh        # health-check (deps, optional --ultra setup)
curl -fsSL .../install.sh | bash                      # re-run = update (idempotent)
rm -rf ~/.claude/skills/plan-panel ~/.claude/skills/finalize ~/.claude/commands/{plan-review,panel-*}.md
```

---

## How it works

1. **scope** — a scoper reads the plan/diff and picks which roles apply.
2. **roles** — each selected role reviews in parallel under a strict protocol
   (checklist → findings with severity → JSON schema). plan-panel reviews a plan;
   finalize reviews a diff (`review_mode=code`) after a deterministic stabilize pass
   (typecheck/lint/test + bounded auto-fix).
3. **judge** — synthesizes all findings, resolves conflicts, emits a priority-ranked
   action list and a verdict.
4. **(optional) cross-model** — for `--ultra`, re-run critical findings through
   GPT-5 / Gemini 2.5 Pro and meta-judge the disagreements.

Roles, the workflow orchestrators (`workflow/*.js`), and the shell lib are all
in this repo. Self-improvement: `/panel-feedback` + `/panel-solidify` refine role
prompts from accumulated feedback (human-in-loop, prompts only).

## Optional: cross-model verify (`--ultra`)

Needs `OPENAI_API_KEY` / `GEMINI_API_KEY` in the environment, or 1Password CLI
refs (configurable). Without them, redplan runs Claude-only and says so. See
`plan-panel/lib/cross-model.sh` and `doctor.sh`.

## License

MIT © 2026 Igor Konovalchik
