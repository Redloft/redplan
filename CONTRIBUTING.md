# Contributing to redplan

Thanks for considering a contribution. This skill is in **beta** — feedback and PRs are very welcome.

## How to contribute

### Bug reports

Include the `metadata.json` from the artifacts directory. It contains `run_id`, model versions, token counts, role completion status — everything needed to reproduce.

⚠️ **Do not include `reviews.json` or `judge.md` if your plan contains sensitive info** (internal API designs, vulnerabilities, etc.). Sanitize first or open a private security issue.

### Feature requests

Open an issue with the `enhancement` label. Especially valuable:
- A real plan where the panel missed something a human reviewer caught
- A missing edge case the orchestrator should handle
- A new role checklist (e.g. `ml-engineer`, `mobile`, `accessibility`)

### Code contributions

```bash
# Fork → clone → branch
git checkout -b feat/your-feature

# Make changes, validate
bash -n lib/*.sh           # shell syntax
node --check workflow/panel.js   # JS syntax
bash lib/run-golden.sh     # validate fixtures still parse

# Commit, push, open PR
```

### Adding a new role

1. Create `roles/<role-name>.md` following the structure of existing roles
2. Add activation rule in `roles/scoper.md` activation_rules section
3. Add prompt entry in `workflow/panel.js` `reviewPrompts` object
4. Add to `ROLE_DEFINITIONS` const
5. Add golden fixture in `fixtures/golden/<role>-test/` to verify activation works
6. Update `README.md` roles table

### Tests

`fixtures/golden/` is our regression set. `lib/run-golden.sh` validates fixture schemas. Full panel-run comparison is on the roadmap (Phase C).

For now, smoke-test manually:
```bash
/plan-review @fixtures/golden/backend-security/plan.md
# Compare output verdict + role activation against fixtures/golden/backend-security/expected.json
```

## Code style

**Bash scripts**:
- `set -euo pipefail` always
- Quote all variable expansions: `"$VAR"` not `$VAR`
- Use `mktemp -d` for temp dirs + `trap 'rm -rf "$TMP"' EXIT`
- Pass `--fail-with-body --proto=https --tlsv1.2` to all curl calls
- Validate inputs early, exit ≠ 0 with helpful message

**JavaScript (workflow scripts)**:
- No `Date.now()`, `Math.random()`, `new Date()` — these break Workflow tool's resume feature
- Use `args.run_id`, `args.timestamp` passed by caller
- Return structured payloads; do not write to FS directly (caller's job)
- Validate JSON schemas via Workflow tool's `schema` option

**Markdown (role specs)**:
- Numbered checklist (8-12 points) — no free-form personality
- Explicit `## Self-check` section at end
- Show ANTI-PATTERNS table — what role does NOT do
- Use the shared output JSON schema from `_shared.md` strictly

## Code of conduct

Be kind, be specific, assume good intent. We're building tools to help each other think more clearly — that ethos applies here too.

## License

By contributing, you agree your contributions will be licensed under MIT.
