# qc-check

An agent-agnostic QC skill for mobile apps.

You give an AI agent a ticket id. It fetches the ticket, writes a test plan and
waits for you to approve it, verifies the backend contract on the live
environment, drives your real app on an emulator through Appium in every
locale you configure, extends the unit tests, and hands back a report with
screenshots attached.

It works with Claude Code, OpenAI Codex, or any agent that can run shell
commands and read files. The procedure lives in one file. The adapters only
map tool names.

```bash
npx qc-check init                       # write qc.config.json
npx qc-check install --agent claude     # or codex, or generic
npx qc-check doctor                     # tell me what is still missing
```

Then, in your agent: `/qc-check ABC-123`

---

## Why this exists

Most AI test automation writes scripts. This drives the actual build on an
actual device and reports what it saw, which catches a different class of
problem:

- **A green screen is not a pass.** If a feature writes data, the endpoint is
  checked on the environment under test before any emulator boots. A UI that
  looks right against an undeployed endpoint is the failure this catches first.
- **Nothing is assumed about your layout.** Selectors drift. The skill inspects
  the live accessibility tree and reacts to what is on screen, instead of
  replaying identifiers that were true last month.
- **A run survives being interrupted.** State, findings and evidence are on
  disk after every step. Restart and it resumes at the sub-step it stopped on,
  rather than starting over.
- **It reports what it observed.** A blocked run says who owns the blocker. A
  pass that was not witnessed on a device is never reported as a pass.

## The run

Ten phases. The gates are hard, not advisory.

| # | Phase | What happens |
|---|-------|--------------|
| 1 | `ticket` | Fetch the ticket, read the code it changed, collect real selectors and entry points |
| 2 | `test-plan` | Write the definition of done and numbered test cases. **You approve it before anything runs** |
| 3 | `contract` | Check the frontend and backend agree on the endpoints this feature writes to |
| 4 | `smoke` | Live backend round trip. **Red here means emulators never boot** |
| 5 | `phone` | Full pass on an Android phone, screenshot per state change, one locale at a time |
| 6 | `tablet` | Tablet pass and responsive checks, only when asked |
| 7 | `ios` | iOS Simulator pass, only when asked |
| 8 | `unit-tests` | Extend the test suites covering the new logic |
| 9 | `report` | Assemble the report from the evidence on disk |
| 10 | `publish` | Post it to the tracker, with labels earned by the verdict |

Three modes:

| Mode | Invocation | What it does |
|------|-----------|--------------|
| Ticket QC | `/qc-check ABC-123` | The ten phases above against one ticket |
| Full sweep | `/qc-check all` | Every screen in the app, in every configured locale, as a screen-by-language matrix |
| Fix loop | `/qc-check fix RUN-ID` | Takes a prior run's findings and loops root cause, fix, re-verify on device, push |

## Install

Requires Node 18 or newer, a running Appium server, and an emulator or
simulator with your app installed.

```bash
# 1. In your app repository
npx qc-check init

# 2. Edit qc.config.json, then fill in the gitignored credentials file
#    it created for you

# 3. Install the skill for your agent
npx qc-check install --agent claude

# 4. Confirm the setup
npx qc-check doctor
```

`install` copies the runtime scripts to `qc/` in your repository and the skill
to wherever your agent looks for skills. Nothing is installed globally except
the Codex skill folder, which is where Codex requires it.

## Configure

One file at your repository root, `qc.config.json`, holds every
project-specific fact: your package identifiers, emulator names, backend URLs
and auth shape, tracker integration, locales, and where your navigation,
translations and API layers live.

Full reference: **[docs/CONFIGURATION.md](docs/CONFIGURATION.md)**. A JSON
Schema ships with it, so a schema-aware editor will complete the keys.

Two settings change the shape of a run:

- `tracker.kind: "none"` drops the ticket fetch and the publish phase. The run
  takes its acceptance criteria from your prompt and leaves the report on disk.
- `backend.enabled: false` drops the contract and smoke phases for an app with
  no backend of its own.

## Agents

| Agent | Installs to | Invocation |
|-------|-------------|------------|
| Claude Code | `.claude/skills/qc-check/` | `/qc-check ABC-123` |
| OpenAI Codex | `~/.codex/skills/qc-check/` | `Use $qc-check for ABC-123` |
| Anything else | `./qc-check-skill/` | bootstrap prompt in `AGENTS.md` |

A host agent needs four capabilities: run shell commands, read and write
files, show visible progress, and ask you a question and wait for the answer.
An agent without the last one can still run headless with `QC_EVAL=1`, which
auto-approves the plan and skips publishing.

Adding support for another agent means writing one page. See
**[docs/ADAPTERS.md](docs/ADAPTERS.md)**.

## Safety

The skill handles a test account and can write to your tracker, so the
boundaries are explicit:

- **Credentials are never read by the agent.** They live in a gitignored file
  that only the runtime scripts open. No credential reaches a report, a log or
  a tracker comment.
- **The test plan is an approval gate.** No device runs before a human
  approves the plan, unless the run is explicitly headless.
- **The smoke test is a stop gate.** A dead backend stops the run instead of
  producing findings that are not about your app.
- **Publishing is a write to someone else's system.** It happens at the end,
  from a finished report, and the pass label requires a genuine pass.
- **Evidence is append-only in practice.** Findings are written the moment
  they are observed, so an interrupted run loses progress but never substance.

## Repository layout

```
skill/SKILL.md            the entire QC procedure, agent-neutral
skill/references/         one file per phase, read when that phase starts
agents/claude-code/       adapter: tool-name mapping only
agents/codex/             adapter: tool-name mapping only
agents/generic/           adapter: bootstrap prompt for any other agent
runtime/                  the scripts the agent drives, config-driven
bin/qc-check.js           installer
qc.config.example.json    every project-specific fact
test/                     installer smoke test and the leak guard
```

`test/no-private-refs.js` asserts that every identifier in the repository is a
placeholder, so a real hostname, package id or ticket prefix cannot be
committed by accident.

```bash
npm test              # installer and runtime smoke test, no device needed
npm run check:leaks   # placeholder-only guard
```

## License

MIT. See [LICENSE](LICENSE).
