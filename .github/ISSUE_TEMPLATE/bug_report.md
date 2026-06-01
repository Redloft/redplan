---
name: Bug report
about: Something didn't work as expected
labels: bug
---

**What happened**
<!-- one line -->

**What you ran**
```
/plan-review ...
```

**Mode**
<!-- lite / standard / heavy / ultra -->

**Artifacts** (please attach or paste)
- [ ] `metadata.json` (contains `run_id`, model versions, token counts — needed to reproduce)
- [ ] Sanitized snippet of `judge.md` if relevant

⚠️ Don't paste actual plan content if it contains sensitive info (vulnerabilities, internal API designs, credentials).

**Expected vs actual**
<!-- e.g. "expected security role to flag .env token storage; got no security activation" -->

**Environment**
- OS:
- Claude Code version: <!-- `claude --version` -->
- Skill commit: <!-- `git -C ~/.claude/skills/plan-panel rev-parse --short HEAD` -->
