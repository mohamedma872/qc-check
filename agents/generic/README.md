# Generic adapter

For any tool-using agent without a purpose-built adapter in `agents/`.

```bash
npx qc-check install --agent generic
```

Installs into the host repository:

| Path | What |
|---|---|
| `qc-check-skill/AGENTS.md` | this adapter: the four capabilities, the bootstrap prompt, the mapping table |
| `qc-check-skill/WORKFLOW.md` | the canonical workflow, copied verbatim from `skill/SKILL.md` |
| `qc-check-skill/references/` | the per-phase reference docs |
| `qc/` | the runtime scripts the workflow calls |

Agents that read `AGENTS.md` files on their own pick it up from there. For
agents that do not, paste the bootstrap prompt from `AGENTS.md` at the start of
the run.

The adapter is a thin layer. It names the capabilities and maps them to host
tool names. The workflow itself stays in one file, shared by every agent, so
porting the skill to a new host never forks the procedure.

Configuration lives in `qc.config.json` at the repo root, written by
`npx qc-check init`. See the repository README and `docs/CONFIGURATION.md` for
every key, and for the gitignored credentials file that the runtime reads and
no agent ever opens.
