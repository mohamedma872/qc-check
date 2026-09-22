# Codex adapter

```bash
npx qc-check install --agent codex
```

Installs to `~/.codex/skills/qc-check/`:

| Path | What |
|---|---|
| `SKILL.md` | this adapter, the entry point Codex loads |
| `openai.yaml` | display name, short description, default prompt |
| `WORKFLOW.md` | the canonical workflow, copied verbatim from `skill/SKILL.md` |
| `references/` | the per-phase reference docs |

The runtime goes to `qc/` in the host repository, with `qc.config.json` at its
root. Restart Codex after installing so the skill list refreshes.

The adapter is a thin layer. It maps Codex tools onto the workflow and nothing
else, so the procedure stays in one file and stays the same across agents.

Invoke it with `Use $qc-check for ABC-123`, `Use $qc-check for full`, or
`Use $qc-check for fix ABC-123`. Launch Codex from the host repository root:
the skill folder is global, but the run reads `qc/` and writes evidence
relative to the repository.

Configuration lives in `qc.config.json`, written by `npx qc-check init`. See
the repository README and `docs/CONFIGURATION.md` for every key, and for the
gitignored credentials file that the runtime reads and no agent ever opens.

Device passes need a shell that can reach the emulator and the network. Grant
the escalation once at the start of the run rather than per command.
