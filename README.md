# qc-check

Run mobile QC on a real device, from one command.

`qc-check run ABC-123` fetches the ticket, writes a test plan and waits for you
to approve it, verifies the backend contract on the live environment, drives
your app on an emulator through Appium in every locale you configure, extends
the unit tests, and hands back a report with screenshots attached.

The work is done by an AI agent. The CLI configures it, feeds it the workflow,
drives the device scripts, and keeps the run resumable. Claude Code, Codex and
anything else are interchangeable backends.

```bash
npm install -g qc-check

cd /path/to/your/app
qc-check setup          # detect the project, write qc.config.json
qc-check doctor         # confirm Appium, a device and an agent are ready
qc-check run ABC-123
```

Full walkthrough: **[docs/SETUP.md](docs/SETUP.md)**

---

## Why this exists

Most AI test tooling writes scripts. This drives the actual build on an actual
device and reports what it saw, which catches a different class of problem:

- **A green screen is not a pass.** If a feature writes data, the endpoint is
  checked on the environment under test before any emulator boots. A UI that
  looks right against an undeployed endpoint is the failure this catches first.
- **Nothing is assumed about your layout.** Selectors drift. The agent inspects
  the live accessibility tree and reacts to what is on screen, instead of
  replaying identifiers that were true last month.
- **A run survives being interrupted.** State, findings and evidence hit disk
  after every step. Restart and it resumes at the sub-step it stopped on.
- **It reports what it observed.** A blocked run says who owns the blocker. A
  pass that was not witnessed on a device is never reported as a pass.

## Commands

| Command | What it does |
|---------|--------------|
| `qc-check setup` | Detect the project and configure it. Run this first |
| `qc-check doctor` | Check every prerequisite and name the fix for what is missing |
| `qc-check run <ticket>` | QC one ticket end to end |
| `qc-check run all` | Sweep every screen in every locale |
| `qc-check run fix <id>` | Loop over a previous run's findings: fix, re-verify, push |
| `qc-check status [ticket]` | Phases, sub-steps, findings, and where a run resumes |
| `qc-check report <ticket>` | The finished report and the evidence beside it |
| `qc-check prompt <ticket>` | Print the prompt instead of running it, for any agent |
| `qc-check install --agent` | Optional: also expose it as a slash command in your agent |

`run` takes `--dry-run` to show exactly what would be executed, `--headless` to
run without a human, and `--agent <kind>` to override the configured backend
for one run.

## The run

Ten phases. The gates are hard, not advisory.

| # | Phase | What happens |
|---|-------|--------------|
| 1 | `ticket` | Fetch the ticket, read the code it changed, collect real selectors |
| 2 | `test-plan` | Definition of done and numbered test cases. **You approve it before anything runs** |
| 3 | `contract` | Check the app and backend agree on the endpoints this feature writes to |
| 4 | `smoke` | Live backend round trip. **Red here means emulators never boot** |
| 5 | `phone` | Full pass on an Android phone, screenshot per state change |
| 6 | `tablet` | Tablet pass and responsive checks, only when asked |
| 7 | `ios` | iOS Simulator pass, only when asked |
| 8 | `unit-tests` | Extend the suites covering the new logic |
| 9 | `report` | Assemble the report from the evidence on disk |
| 10 | `publish` | Post it to the tracker, with labels earned by the verdict |

## Configuration

One file at your repository root, `qc.config.json`, written by `qc-check setup`
and safe to edit by hand. It holds every project-specific fact: package
identifiers, device profiles, backend URLs and auth shape, tracker wiring,
locales, source layout, build commands and which agent to use.

Full key reference: **[docs/CONFIGURATION.md](docs/CONFIGURATION.md)**. A JSON
Schema ships with it, so a schema-aware editor completes the keys.

Three settings change the shape of a run:

- `tracker.kind: "none"` drops the ticket fetch and the publish phase. The run
  takes its acceptance criteria from your prompt and leaves the report on disk.
- `backend.enabled: false` drops the contract and smoke phases for an app with
  no backend of its own.
- `agent.kind: "none"` stops the CLI invoking anything. Use `qc-check prompt`
  and paste into whatever you like.

## Agents

| `agent.kind` | Behaviour |
|--------------|-----------|
| `claude` | Invokes the `claude` binary |
| `codex` | Invokes the `codex` binary |
| `custom` | Runs `agent.command`, with `{prompt}` substituted or the prompt on stdin |
| `none` | Prints the prompt for you to paste |

The workflow is one file, `skill/SKILL.md`, shared by every backend and by the
CLI. Nothing about the procedure is per-agent, so it cannot drift. Adding
support for another agent means a `custom` command or one page: see
**[docs/ADAPTERS.md](docs/ADAPTERS.md)**.

## Safety

The tool handles a test account and can write to your tracker, so the
boundaries are explicit:

- **Credentials never reach the agent.** They live in a gitignored file that
  only the device scripts open, typed in with `driver.js input --credential`.
  The config loader makes credential objects render as redacted through logging
  and serialization, so they cannot leak by accident.
- **The test plan is an approval gate.** No device runs before a human approves
  the plan, unless the run is explicitly headless.
- **The smoke test is a stop gate.** A dead backend stops the run instead of
  producing findings that are not about your app.
- **Publishing is a write to someone else's system.** It happens at the end,
  from a finished report, and the pass label requires a genuine pass.
- **Findings are written when observed.** An interrupted run loses progress but
  never substance.

## Repository layout

```
bin/qc-check.js        the CLI entry point
cli/                   one file per command
skill/SKILL.md         the entire QC procedure, agent-neutral
skill/references/      one file per phase, read when that phase starts
runtime/               the device scripts, installed into your repo as qc/
agents/                optional slash-command adapters
qc.config.example.json every project-specific fact
test/                  smoke test and the leak guard
```

`test/no-private-refs.js` asserts that every identifier in the repository is a
placeholder, so a real hostname, package id or ticket prefix cannot be
committed by accident.

```bash
npm test              # CLI and runtime smoke test, no device needed
npm run check:leaks   # placeholder-only guard
```

## License

MIT. See [LICENSE](LICENSE).
