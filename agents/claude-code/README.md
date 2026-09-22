# Claude Code adapter

> Optional. `qc-check run` already drives your agent from the shell. Install an
> adapter only if you would rather start a run from inside an agent session.

```bash
qc-check install --agent claude
```

Installs into the host repository:

| Path | What |
|---|---|
| `.claude/skills/qc-check/SKILL.md` | this adapter, the entry point Claude Code loads |
| `.claude/skills/qc-check/WORKFLOW.md` | the canonical workflow, copied verbatim from `skill/SKILL.md` |
| `.claude/skills/qc-check/references/` | the per-phase reference docs |
| `qc/` | the runtime scripts the workflow calls |

The adapter is a thin layer. It maps Claude Code tools onto the workflow and
nothing else, so the procedure stays in one file and stays the same across
agents.

Invoke it with `/qc-check ABC-123`, `/qc-check full`, or `/qc-check fix ABC-123`.
Plain English works too, for example "QC check ABC-123 on phone and tablet".

Configuration lives in `qc.config.json` at the repo root, written by
`qc-check setup`. See the repository README and `docs/CONFIGURATION.md` for
every key, and for the gitignored credentials file that the runtime reads and
no agent ever opens.

Optional: allowlist `Bash(node qc/*)` in `.claude/settings.json` so a device
pass does not prompt on every step.
