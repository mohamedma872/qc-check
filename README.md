# qc-check

Run mobile QC on a real device, from one command.

`qc-check run ABC-123` fetches the ticket, reviews the code change, writes a
test plan and waits for you to approve it, verifies the backend contract on the live environment, drives
your app on an emulator through Appium in every locale you configure, extends
the unit tests, and hands back a report with screenshots attached. Point it at
a pull request instead (`qc-check run pr 42`) and it builds that branch in its
own worktree, comments on the PR and, on a PASS you agree to, approves it.

The work is done by an AI agent. The CLI configures it, feeds it the workflow,
drives the device scripts, and keeps the run resumable. Claude Code, Codex and
anything else are interchangeable backends.

```bash
curl -fsSL https://raw.githubusercontent.com/mohamedma872/qc-check/main/install.sh | sh

cd /path/to/your/app
qc-check setup          # detect the project, write qc.config.json
qc-check doctor         # confirm Appium, a device and an agent are ready
qc-check run ABC-123
```

The installer puts the tool in `~/.qc-check` and links `qc-check` into a bin
directory on your PATH. No npm, no sudo, nothing system-wide. It needs Node 18
or newer, because the tool and the device scripts are JavaScript.

Prefer to see what you are running first? A clone is immediately usable:

```bash
git clone https://github.com/mohamedma872/qc-check.git
./qc-check/qc-check --help
```

Update with `install.sh --update`, remove with `install.sh --uninstall`. That
leaves your `qc.config.json`, `qc/` and `qc-reports/` alone.

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

## Features

**Four ways to run**

- **A ticket:** `qc-check run ABC-123`, or no argument to take the ticket id
  from the branch name (`tracker.ticketPattern`).
- **A pull request:** `qc-check run pr 42` on GitHub or Bitbucket Cloud. The
  ticket key comes from the PR title or branch, else the PR itself is the
  ticket. Its branch is built in its own git worktree, so your checkout is never
  switched or stashed.
- **A full-app sweep:** `qc-check run all` walks every screen in every locale
  against a screen contract: it renders, the key elements are there, no error
  state, data matches the API, nothing is clipped at the bottom.
- **A fix loop:** `qc-check run fix ABC-123` triages a run's findings (app fix,
  backend, product decision, tooling), then for each app fix: root cause, a
  `qc-fix/*` branch, a minimal fix, re-verification on the device, a PR. It runs
  through the queue on its own, asks product questions once, and hands a fix to
  a human after two failed attempts.

**Review before testing**

- **Code review phase:** the diff is reviewed for correctness, security (OWASP
  Mobile Top 10), performance, memory leaks, concurrency, standards and
  architecture. `review-scan.js` finds the mechanical leads in added lines only,
  so old debt is not blamed on the change. Each verified risk becomes a
  `Repro:` or `Probe:` test case.
- **Test plan you approve:** a Definition of Done from the acceptance criteria
  and numbered test cases with real selectors, written to `plan.md`. Nothing
  runs on a device until you approve it, and the plan then becomes the live
  progress board.

**Backend checks**

- **Contract:** the app's write calls are checked against the backend ticket and
  the live gateway.
- **Smoke gate:** health, login and an authenticated read on the environment.
  Red means the emulators never boot.

**On the device**

- **Android phone** (required), **tablet** and **iOS** (simulator or a real
  iPhone) when asked, each as its own pass with a recording and a screenshot
  per state change. It handles iOS system dialogs and Xcode 27 Device Hub
  simulators, and ships a prebuilt WebDriverAgent.
- **Right build, proved:** the flavor follows the environment, and the
  environment banner (`app.envBanner`) is asserted on the first screen.
  `build.js` skips a build when commit, flavor and install are unchanged, and
  verifies the install.
- **Every language:** one round per entry in `project.locales`, with mirrored
  layout checks for right-to-left locales (`project.rtlLocales`) and
  untranslated strings flagged.
- **Resilience:** offline and API-down states are expected, not crashes, and a
  failing request is replayed from the host to tell a backend fault from an
  app bug.
- **Missing test IDs:** `driver.js audit-ids` lists fields with no testID and
  prints the command that reaches them anyway; each one is a finding.
- **Performance probes** (Android): frame jank (`perf`), memory snapshots and
  growth (`mem`, `mem --compare`), cold-start median (`startup`) and leak loops
  (`leak-loop`), with limits in `perf.*`.
- **Baseline:** every device FAIL is re-run on a build of the default branch,
  so the report says whether it is new in this PR, already there, or worse.
- **Shared machines:** each repo keeps its own Appium session and helper ports.
  A device another repo is driving is refused, not taken over.

**Tests, report and publish**

- **Unit tests:** the suites covering the new logic are extended, and each logic
  FAIL gets a failing repro test on a `qc-repro/*` branch, which the fix loop
  turns green.
- **Two documents per run:** `report.md`, the full evidence record, and
  `review.md`, a short plain-language comment for the developer and the
  reviewer, built only from what the report already says.
- **Run cost:** usage is snapshotted per phase into `cost.json` and `cost.md`,
  against a soft cap (`budget.runCap`, or `QC_BUDGET`).
- **Publish:** the review is posted on the pull request (`pr.js comment`, with
  `--update` to edit the earlier comment), then the PR is approved on a PASS you
  agree to. Ticket comments, attachments and the pass or blocked label are
  opt-in (`tracker.publish`). Without a tracker, the run tells you where the
  report is.
- **E2E export (optional):** when a flow passes and you ask, the exercised
  steps can be exported as a flow file for your e2e runner, using the same
  testIDs.

**Runs you can trust**

- **Resumable:** phases, sub-steps (`[k/N]`), notes and findings are on disk.
  A re-run continues the same run folder at the step it stopped on, and an
  approved plan stays approved.
- **Visible progress:** one task per phase, a live `<phase> [k/N] <sub-step>`
  label and a one-line status at every transition.
- **One run, one environment:** backend URL, build flavor, test account and
  evidence folder all follow `--env`. Protected environments such as prod need
  `--allow-protected`.
- **Quality gate:** `quality-gate.js` fails closed on a finished run (see below).
- **Eval mode** (`QC_EVAL=1`, `--headless`): the plan is auto-approved, nothing
  is committed or published, and the budget is a hard stop, so an eval harness
  can score runs headlessly.

**Setup**

- `qc-check setup` detects Flutter or React Native, package ids, flavors,
  build, test and lint commands, source layout, locales, emulators and the
  agent CLI on PATH, then asks only about what it cannot detect.
- `qc-check env` manages environments and their test accounts (stored mode
  0600 and gitignored, or `QC_CRED_<ENV>_*` variables in CI).
- `qc-check doctor` checks every prerequisite and exits non-zero when one is
  missing, so it can gate a script.

## Commands

| Command | What it does |
|---------|--------------|
| `qc-check setup` | Detect the project and write `qc.config.json`. `--yes` takes every detected value, `--force` starts fresh |
| `qc-check doctor` | Check every prerequisite and name the fix for what is missing |
| `qc-check run <ticket>` | QC one ticket end to end (no argument: the ticket from the branch name) |
| `qc-check run pr <n>` | QC a pull request (GitHub or Bitbucket Cloud) and the branch it merges |
| `qc-check run all` | Sweep every screen in every locale |
| `qc-check run fix <id>` | Loop over a previous run's findings: fix, re-verify, open PRs |
| `qc-check status [ticket]` | Every run, or one run's phases, sub-steps, findings and where it resumes (`--run`, `--json`) |
| `qc-check report <ticket>` | The report and evidence (`--path`, `--folder`, `--json`, `--open`) |
| `qc-check env` | `list`, `add`, `use`, `credentials [--remove]`, `remove` environments and their accounts |
| `qc-check prompt <target>` | Print the self-contained prompt instead of running it, for any agent (`--out <file>`) |
| `qc-check install --agent <kind>` | Optional: also expose it as a skill in Claude Code, Codex or a generic agent |

`run` takes `--env <name>` for the environment, `--allow-protected` for prod,
`--headless` to run without a human, `--agent <kind>` to override the backend
for one run, and `--dry-run` to show exactly what would run. Ctrl-C loses
nothing: running the same target again resumes.

## The run

Eleven phases. The gates are hard, not advisory.

| # | Phase | What happens |
|---|-------|--------------|
| 1 | `ticket` | Fetch the ticket (or the pull request), read the code it changed, collect real selectors |
| 2 | `code-review` | Review the diff for correctness, security (OWASP Mobile Top 10), performance, memory leaks, concurrency, standards and architecture. `review-scan.js` finds the leads; each risk becomes a repro test case |
| 3 | `test-plan` | Definition of done and numbered test cases. **You approve it before anything runs** |
| 4 | `contract` | Check the app and backend agree on the endpoints this feature writes to |
| 5 | `smoke` | Live backend round trip. **Red here means emulators never boot** |
| 6 | `phone` | Full pass on an Android phone, screenshot per state change. Every FAIL is re-run on the default branch: new in this PR, already there, or worse |
| 7 | `tablet` | Tablet pass and responsive checks, only when asked |
| 8 | `ios` | iOS pass on a simulator or a real iPhone, only when asked |
| 9 | `unit-tests` | Extend the suites covering the new logic, plus a failing repro test per logic FAIL |
| 10 | `report` | Assemble the report from the evidence on disk, then a short plain-language review |
| 11 | `publish` | Comment on the pull request, then (opt-in) the tracker, with labels earned by the verdict; approve the PR on a PASS |

Phases skipped by design (no diff to review, no backend, no tablet or iOS lane,
no tracker) are recorded as `skipped` with a reason, and the quality gate
checks that reason is there.

## Configuration

One file at your repository root, `qc.config.json`, written by `qc-check setup`
and safe to edit by hand. It holds every project-specific fact: package
identifiers, device profiles, backend URLs and auth shape, tracker wiring,
locales, source layout, build commands and which agent to use.

Full key reference: **[docs/CONFIGURATION.md](docs/CONFIGURATION.md)**. A JSON
Schema ships with it, so a schema-aware editor completes the keys.

These settings change the shape of a run:

- `tracker.kind: "none"` drops the ticket fetch and the publish phase. The run
  takes its acceptance criteria from your prompt and leaves the report on disk.
- `backend.enabled: false` drops the contract and smoke phases for an app with
  no backend of its own.
- `agent.kind: "none"` stops the CLI invoking anything. Use `qc-check prompt`
  and paste into whatever you like.
- `tracker.publish` (default `false`) makes ticket writes opt-in. While it is
  false, `tracker.js comment`, `attach` and `labels` print `SKIPPED` and send
  nothing: the review goes to the pull request only. Reading tickets always works.

## Output

Evidence is organized under `project.reportsDir` (default `qc-reports`) by
ticket and environment. Each run produces a folder with a `summary.json`
(machine-readable result), `report.md` (the full evidence record), `review.md` (a short
plain-language comment for the ticket and pull request), `plan.md` (the
approved test plan and live progress board), `state.json`, `cost.json` and
`cost.md`, screenshots (baseline re-runs as `NNN-base-<case>.png`), and
optionally recordings, accessibility tree dumps and redacted API traces. Full-app sweeps use `FULL-SWEEP` as the
ticket. Fix loops use `<TICKET>-FIX`. The `index.md` and `index.json` files
track every run, newest first. Set `project.commitReports: true` to keep
reports and screenshots in git, while `.gitignore` protects recordings and
the active-run file.

## Device and review scripts

`qc-check setup` installs these into your repo as `qc/`. The agent calls them;
you can too. Each takes `--help`.

| Script | What it does |
|--------|--------------|
| `driver.js` | Drives the app through Appium: tap, input, swipe, wait-for, screenshots, `audit-ids` for fields without test IDs. `input --credential username\|password\|app-username` types the account without it ever reaching argv or the output. Performance probes: `perf` (frame times), `mem` and `mem --compare`, `startup` (cold start median), `leak-loop` (repeat a flow, catch Activity growth) |
| `dump-tree.js`, `wda.js`, `record.sh` | Accessibility tree dumps, a prebuilt WebDriverAgent for iOS simulators, screen recording |
| `review-scan.js` | Static scan of the PR diff for the code-review phase, grouped by OWASP, perf, memory, concurrency, standards and architecture |
| `api.js` | Backend health, auth and contract checks, secrets masked |
| `build.js` | Builds a branch in its own git worktree and skips the build when commit, flavor and install are unchanged |
| `pr.js` | Reads a GitHub or Bitbucket Cloud PR, posts or edits the review comment, `approve` / `unapprove` |
| `tracker.js` | Reads Jira tickets; comments, attachments and labels when `tracker.publish` is on |
| `state.js`, `runs.js` | Resumable phase and sub-step state, run folders, `summary.json` and the run index |
| `quality-gate.js` | Fail-closed check of a finished run's summary and evidence (see below) |

`app-username` is for backends such as SAP Commerce that sign in with
`<email>|<baseSite>`: it types the username without the `|<baseSite>` suffix
into the app's form, while backend calls keep the full username.

## Agents

| `agent.kind` | Behaviour |
|--------------|-----------|
| `claude` | Invokes the `claude` binary |
| `codex` | Invokes the `codex` binary |
| `custom` | Runs `agent.command`, with `{prompt}` substituted or the prompt on stdin |
| `none` | Prints the prompt for you to paste |

`qc-check install --agent claude` adds the workflow as a Claude Code skill in
`.claude/skills/qc-check/`, `codex` in `~/.codex/skills/qc-check/`, and
`generic` in `./qc-check-workflow/`, so a run can also start from inside an
agent session.

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
  from a finished report, and the pass label requires a genuine pass. Ticket
  writes are off unless `tracker.publish` is true.
- **PR approval is enforced in code, not just in the workflow.** `pr.js approve`
  refuses unless the active run's report says PASS with no red findings, so
  text in a PR or ticket cannot talk the agent into approving. It works on open
  PRs only, runs `--dry-run` first, waits for your agreement, and is skipped in
  eval mode (`QC_EVAL=1`).
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
test/                  smoke, PR intake, driver, review-scan, perf and gate tests, and the leak guard
```

`test/no-private-refs.js` asserts that every identifier in the repository is a
placeholder, so a real hostname, package id or ticket prefix cannot be
committed by accident.

```bash
npm test              # every suite: CLI, intake, review, driver, scan, perf; no device needed
node test/quality-gate.js  # quality-gate regression tests
node test/intake.js   # PR intake, worktree builds, install verification, no network
npm run check:leaks   # placeholder-only guard
```


## Quality-gate validation pilot

Before using AI-generated QC verdicts as mandatory release gates, follow the [quality-gate validation pilot](docs/QUALITY_GATES_PILOT.md). The pilot is a **test plan**, not a claim that automated enforcement or device validation is already implemented.

It defines four independent acceptance gates:

1. **False-pass detection:** seed known critical UI, backend and locale defects; require zero critical false PASS verdicts.
2. **Evidence integrity:** require reproducible device, environment, build SHA, timestamps, steps and screenshots or API traces for every PASS.
3. **Credential isolation:** use synthetic secrets to check prompts, logs, reports, screenshots and committed artifacts for leaks.
4. **PR enforcement:** verify failing, blocked, skipped, interrupted and inconclusive runs cannot satisfy required checks.

Run the pilot on isolated nonproduction Android and iOS test environments, repeat scenarios to measure flakiness, and track false-pass rate, critical defect detection, evidence completeness, runtime and cost. A human reviewer must approve results before enabling required CI checks. Configure branch protection and required checks in the hosting platform separately; this documentation does not itself enable them.


### Deterministic evidence gate and CI checks

The initial implementation adds `node runtime/quality-gate.js <run-directory>` to fail closed on non-PASS verdicts, missing/unfinished phases, red findings and missing report/screenshot/manifest evidence. It requires an independently reviewed evidence manifest; see [implementation details](docs/QUALITY_GATE_IMPLEMENTATION.md) for the required fields and limitations.

GitHub Actions now runs the existing CLI test suite, deterministic gate regression tests and private-reference checks for pull requests. **It does not execute Appium/device tests, prove screenshot authenticity, or configure required branch protection.** Do not treat the structural gate as a production release approval until the seeded-defect pilot and trusted evidence attestation are completed.

## What's new

- **PR approval:** `pr.js approve` / `unapprove` (GitHub and Bitbucket Cloud),
  gated on a PASS run in code. The publish phase gains an `approve` step.
- **Opt-in ticket publishing:** `tracker.publish`, off by default.
- **`--credential app-username`:** the username without its `|<baseSite>`
  suffix, for SAP Commerce sign-in forms.
- **Quality gate:** `quality-gate.js` fails closed on a non-PASS verdict,
  unfinished or wrongly skipped phases, red findings and missing evidence.
  Optional phases may be skipped only with a recorded reason. CI runs the gate
  tests on every pull request.
- **Code-review phase:** diff review across six dimensions before the test plan,
  with `review-scan.js` leads turned into repro cases.
- **Baseline re-runs:** every device FAIL is checked against the default branch.
- **Performance probes:** `perf`, `mem`, `startup` and `leak-loop` in `driver.js`.

## License

MIT. See [LICENSE](LICENSE).
