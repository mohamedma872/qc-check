---
name: qc-check
description: Device-level QC for a mobile app. Fetches the ticket, gets a numbered test plan approved, verifies the backend REST contract, drives the real app on an Android emulator or iOS simulator through Appium, extends unit tests, and publishes an evidence-backed report. Use when asked to QC check, device-test, smoke-test, sweep the app, or validate a ticket, PR, or release build.
---

You are a mobile QC engineer. Your job: drive the **real app** on a device or
emulator to verify a ticket's acceptance criteria, and produce a report the team
can act on.

This file is the canonical workflow and it is the same for every agent. Host
specifics (how you are invoked, what your task list and question tools are
called) live in your agent's adapter, installed at whatever location that host
uses for skills. Nothing about any
particular app is written here. Every project fact comes from `qc.config.json`
at the host repository root, cited below as `config.<path>`.

**Arguments**, one of:

- a ticket ID such as `ABC-123`: the standard per-ticket QC run below.
- `full` / `all` / `sweep`: **full-app sweep mode**, QC every screen with no
  ticket. Read `references/full-sweep.md` FIRST. It remaps the phases
  (pseudo-ticket `FULL-SWEEP`, screen inventory instead of ticket fetch,
  per-screen checklist as the test plan, contract and unit-test phases
  skipped).
- `fix [RUN-ID]`: **fix loop**, take a prior run's findings and loop triage,
  root-cause, fix, re-verify on device, push, PR until the app-side findings
  are closed. Read `references/fix-loop.md` FIRST.

Everything below still governs progress, resume, and gates.

## Core principle: be ADAPTIVE, not prescriptive

The app changes; selectors and flows drift. Never assume a hardcoded selector
exists. Inspect the live tree (`node qc/dump-tree.js`) and react to what is
actually on screen. Screenshot after every state change and *look at it* before
the next action. When a tap fails, dump the tree and find the real id. Do not
retry the same guess.

The app may ship several languages (`config.project.locales`), some of them
right-to-left (`config.project.rtlLocales`). Text selectors are
locale-dependent, because the strings live under
`config.codeMap.translationsDir`, so prefer `testID`s. They are
language-independent.

## The config is the only source of project facts

`qc.config.json` at the host repo root is plain JSON and safe to read whenever
you need a value. The runtime scripts under `qc/` read it for you.

| You need | Read |
|---|---|
| Where evidence and state go | `config.project.reportsDir`, written `<reportsDir>/` below |
| Languages to cover, and which are RTL | `config.project.locales`, `config.project.rtlLocales` |
| Ticket id shape, tracker, tool names, labels | `config.tracker.*` |
| Package, bundle id, activity, flavor | `config.app.*` |
| How to build and install the app | `config.app.build.android`, `config.app.build.ios` |
| Proof the build is the right flavor | `config.app.envBanner` |
| Branch to diff against, how to open a PR | `config.repo.defaultBranch`, `config.repo.prCommand` |
| Which device profiles exist and are enabled | `config.devices.android`, `config.devices.android_tablet`, `config.devices.ios` |
| Appium endpoint | `config.devices.appium` |
| Backend base URLs, auth, health and smoke paths | `config.backend.*` |
| Where the app's code lives, how to test it | `config.codeMap.*` |
| Run cost cap | `config.budget.runCap`, `config.budget.currency` |
| Test credentials | `config.credentialsFile`, via the scripts only, see below |

**Credentials.** The file named by `config.credentialsFile` is gitignored and
holds a real username and password. Never open it, never `cat` it, never print
a value, and never write one into a report, a log, or a screenshot caption.
`node qc/api.js` logs in from it by itself, and `node qc/driver.js` types from
it without the value ever passing through you:

```bash
node qc/driver.js input --selector <username-field-testID> --credential username
node qc/driver.js input --selector <password-field-testID> --credential password
```

For a credential field that flag does not cover, let the shell carry the value
so it still never passes through you:

```bash
node qc/driver.js input --selector <id> --text "$(node -p "const c=require('./qc/config.js').loadCredentials(); c[process.env.QC_ENV||c.env].<field>")"
```

The credentials object itself prints as `[credentials redacted]`. If the file
is missing or a field is empty, stop and ask the user to create it from
`qc/credentials.example.js` (`qc-check setup` writes it) and fill it in.

## Step 0: visible progress and resume, before anything else

The user must be able to watch the run progress, and the run must survive being
stopped. Five mechanisms, all mandatory:

1. **Check for a resumable run.** Derive the ticket ID (Phase 1 below, it is
   cheap), then:
   ```bash
   node qc/state.js ABC-123 get
   node qc/cost.js ABC-123 snapshot baseline   # cost baseline for THIS session, also on every resume
   ```
   If prior state exists, this re-run **RESUMES. It never starts from
   scratch**, no matter why the previous run stopped (crash, closed session,
   context loss, user abort). First rebuild your context from disk: the state
   output above (phases, sub-steps, notes, findings), the plan board
   `<reportsDir>/ABC-123-plan.md`, and the evidence already in `<reportsDir>/`.
   Then tell the user what already passed and **resume at the `phase/sub-step`
   it suggests**. Do not redo a green smoke test, a passed phone run, or the
   sub-steps a phase already cleared. An approved `test-plan` stays approved;
   do not re-ask. The ONLY paths to a fresh start are `get` printing "fresh
   run", or the user explicitly asking for a full re-run, and then
   `node qc/state.js ABC-123 reset` comes first.

2. **Create the visible task list**, one task per phase below. Skip `tablet`
   and `ios` unless requested, and skip already-passed phases when resuming.
   Your adapter names the tool that renders a task list to the user. Mark each
   task in progress when you start it and completed when it resolves, and
   mirror every transition into the state file:
   ```bash
   node qc/state.js ABC-123 set <phase> <in_progress|pass|fail|blocked|skipped> [note]
   ```
   At every phase transition, also post a **one-line status message** to the
   user, for example "Smoke green, booting the phone emulator".

3. **Track sub-steps inside every phase.** Each phase has canonical sub-steps,
   listed in the table below and in its reference doc. They are seeded
   automatically when you set the phase `in_progress`, and
   `node qc/state.js ABC-123 get` shows per-phase `[k/N]` progress plus the
   exact `phase/sub-step` to resume at. Record every sub-step transition as you
   work:
   ```bash
   node qc/state.js ABC-123 step <phase> <sub-step> <status> [note]   # e.g. step phone login pass
   node qc/state.js ABC-123 plan <phase> <s1,s2,...>                  # replace the sub-step list
   ```
   For **device phases**, `plan` the pass before starting it, replacing the
   generic `cases` step with one step per test case in the **approved test
   plan**. The numbering must match `<reportsDir>/ABC-123-plan.md`, e.g.
   `plan phone preflight,connect,login,record,case-1,case-2,case-3,teardown`.
   Keep the visible task list in sync at the same granularity: when a sub-step
   starts, update the phase task's live label to `<phase> [k/N] <sub-step>` so
   the user always sees exactly where the run is. A sub-step that fails or
   blocks also gets a one-line status message carrying the note.

4. **Track run cost.** `state.js set` auto-snapshots usage per phase into
   `<reportsDir>/ABC-123-run-cost.{json,md}` through `qc/cost.js`. The
   `baseline` snapshot above makes per-session deltas honest in mixed sessions.
   You never need to call `cost.js` manually mid-run, only
   `node qc/cost.js ABC-123 get` when assembling the report, which must include
   the run-cost summary line. The cap is `config.budget.runCap` in
   `config.budget.currency`, overridable by the `QC_BUDGET` environment
   variable. As the cap approaches, prefer finishing the report over one more
   test case.

5. **Persist findings the moment you observe them.** Never hold them only in
   conversation. An interrupted run must lose zero report substance:
   ```bash
   node qc/state.js ABC-123 finding <red|yellow> <text>   # red = backend or product, yellow = quality or tooling
   ```
   Everything the report needs must live on disk under `<reportsDir>/`: run
   state with its sub-steps, notes and findings, the approved plan with its
   progress cells, and per-step screenshots and videos. If a fact matters for
   the report, write it down when you learn it, not when you assemble.

## Phases (each is one task in the list; gates are hard)

| # | Phase (`state.js` name) | What | Default sub-steps | Read first |
|---|---|---|---|---|
| 1 | `ticket` | Get the ticket ID and fetch the ticket | `derive-id, fetch-ticket, read-code` | below |
| 2 | `test-plan` | Write DoD and numbered test cases to `<reportsDir>/ABC-123-plan.md`. **Gate: THE USER MUST APPROVE before anything below runs** | `dod, test-cases, write-md, approval` | `references/test-plan.md` |
| 3 | `contract` | Verify the app-to-backend REST contract: code, backend ticket, live gateway | `identify-write, be-ref, live-check, verdict` | `references/backend-contract.md` |
| 4 | `smoke` | Backend live smoke test. **Gate: red means STOP, never boot emulators** | `health, auth, roundtrip, verdict` | `references/backend-contract.md` |
| 5 | `phone` | Full device pass on the Android phone profile (`config.devices.android`). **Required** | `preflight, connect, login, record, case-1…N, teardown` | `references/device-driving.md` |
| 6 | `tablet` | Android tablet pass (`config.devices.android_tablet`) plus responsive checks. **Only if explicitly requested** | same as `phone` | `references/device-driving.md` |
| 7 | `ios` | iOS Simulator pass (`config.devices.ios`). **Only if explicitly requested** | same as `phone` | `references/device-driving.md` |
| 8 | `unit-tests` | Extend the unit suites for the ticket's new logic | `identify-units, extend-suites, run-green, commit` | `references/unit-tests.md` |
| 9 | `report` | Assemble the QC report | `assemble` | `references/reporting.md` |
| 10 | `publish` | Post the report and evidence to the tracker, labels gated by verdict | `comment, attachments, labels, confirm` | `references/reporting.md` |

Read each reference **when you reach that phase**, not all up front. If
`node qc/state.js ABC-123 get` shows different sub-step names for a phase, the
runtime is authoritative: use its names, or `plan` the list you need.

### Phase 1: ticket

Sub-steps `derive-id`, `fetch-ticket`, `read-code` match the blocks below in
order. In sweep mode `derive-id` is the literal `FULL-SWEEP`, `fetch-ticket`
builds the screen inventory from `config.codeMap.navigationGlob`, and
`read-code` notes each screen's data source. See `references/full-sweep.md`.

If an argument is provided, use it, uppercased. Otherwise derive it from the
branch name with the configured pattern:

```bash
PATTERN=$(node -p "require('./qc.config.json').tracker.ticketPattern")
git rev-parse --abbrev-ref HEAD | grep -oiE "$PATTERN" | head -1 | tr 'a-z' 'A-Z'
```

Validate what you derived before spending anything on it:

```bash
node -e "process.exit(require('./qc/config.js').validateTicket(process.argv[1])?0:1)" ABC-123
```

Then fetch the ticket:

- `config.tracker.kind` is `jira` or `github` **and**
  `config.tracker.tools.getIssue` is non-empty: call that tool by that exact
  name with the ticket ID, against `config.tracker.site` and
  `config.tracker.projectKey`. Collect the title, description, acceptance
  criteria (checklist, "should", "must", "when…then"), linked issues such as
  backend sub-tasks and "blocked by", and design links.
- `config.tracker.kind` is `none`, or the tool name is empty: there is nothing
  to fetch. Ask the user to paste the ticket text and its acceptance criteria,
  wait for the answer, and save it to `<reportsDir>/ABC-123-ticket.md` so a
  resumed run does not ask twice. Record the sub-step as
  `step ticket fetch-ticket pass no tracker configured, ACs supplied by user`.

Then **read the code under test** so test cases use real selectors and entry
points:

```bash
BASE=$(node -p "require('./qc.config.json').repo.defaultBranch")   # default: main
git diff --name-only "$(git merge-base HEAD "$BASE")"...HEAD      # files this change touches
SRC=$(node -p "require('./qc.config.json').codeMap.sourceDir")     # default: src
grep -rn "ComponentName" "$SRC" --include='*.tsx'                 # where it is used
```

If the branch targets a release branch rather than `config.repo.defaultBranch`,
say so and diff against that instead. Note the actual `testID`s in the markup and
**which screen triggers the feature**. This is the raw material for the test
plan: collect selectors, entry points, and every write the feature performs,
meaning the service call under `config.codeMap.apiServicesGlob` and the
mutation hook under `config.codeMap.mutationsGlob`. Flag any interactive
element missing a `testID` as a finding.

### Phase 2: test plan (DoD and test cases; hard user-approval gate)

Follow `references/test-plan.md`. Derive the **Definition of Done** from the
acceptance criteria, write **numbered test cases** using the real selectors
from Phase 1, save both to `<reportsDir>/ABC-123-plan.md`, then **STOP and get
the user's approval**. Present Approve or Request changes, wait for the answer,
and iterate until approved. Your adapter names the tool that asks the user a
question and blocks on the reply. `state.js` refuses to start any later phase
until `test-plan` is `pass`. The approved file is also the live progress board:
later phases flip its DoD and case status cells as they resolve.

### Phases 3 and 4: backend contract and smoke, mandatory before any emulator

A green UI is **not** a pass for any feature that writes data. The endpoint may
not exist, or may not be deployed on the QC environment. And booting emulators
against a dead backend wastes many minutes. Follow
`references/backend-contract.md` exactly. It gates everything after it.

- Skip the `contract` phase only for purely presentational features:
  `set contract skipped presentational change`.
- If `config.backend.enabled` is false there is no backend to check. Skip both
  phases with that reason and say so in the report.
- The environment is `config.backend.defaultEnv`, overridable by the `QC_ENV`
  environment variable, and its base URL is `config.backend.baseUrls.<env>`.
  Health is `config.backend.healthPath` (`api.js --health`), the cheap
  authenticated read is `config.backend.smokePath` (`api.js --smoke`), and
  login is `config.backend.auth.*`. `qc/api.js` applies all of this, including
  `config.backend.headers`.

### Phases 5 to 7: device passes, phone required, tablet and iOS on request

Run each form factor as its **own task and own pass**: connect, record, test
cases, stop recording, disconnect. The Android phone profile is **required**.
Tablet and iOS run only when the user asked, or when the change is form-factor
or platform specific. A profile with `enabled: false` in `config.devices`
cannot run: say so instead of silently skipping. A form factor that was
requested but cannot be built or booted is BLOCKED for that form factor, not a
pass.

The build under test is `config.app.defaultFlavor`, overridable by `QC_FLAVOR`,
which resolves to `config.app.flavors.<flavor>.androidPackage` and
`.iosBundleId` and launches at `config.app.androidActivity`. Build and install
it with `config.app.build.android` or `config.app.build.ios`. An empty build
command means there is no agreed way to build here: ask the user how, or ask
them to install the build, before the `preflight` sub-step ends.

`config.app.envBanner`, when set, is the text a non-production build shows.
Assert it on the first screen. It is the cheapest proof that the app on the
device is the flavor you think you are testing. Missing banner on a build that
should have one is a finding, not a detail.

Everything else
device-side (connect, login, language and RTL rounds, permissions, offline
mode, per-host gotchas) is in `references/device-driving.md`.

### Phases 8 to 10: tests, report, publish

Follow `references/unit-tests.md`. The logic worth covering lives under
`config.codeMap.apiServicesGlob`, `config.codeMap.mutationsGlob`,
`config.codeMap.queriesGlob`, `config.codeMap.utilsGlob` and
`config.codeMap.validationGlob`. Extend the co-located suites with
`config.codeMap.testCommand`, keep `config.codeMap.lintCommand` and
`config.codeMap.typecheckCommand` green, and treat new logic with no unit test
as a yellow finding. If `config.codeMap.testsGitignored` is true, committing
tests needs `git add -f`.

Then `references/reporting.md` for the report template and the publish step.
Publish happens **regardless of verdict**. A FAIL or BLOCKED run with evidence
is more useful than silence. Be honest: report BLOCKED with whose scope it is,
and never report a pass you did not observe.

Publish degrades with the tracker:

| `config.tracker.kind` and tools | Publish does |
|---|---|
| A tracker, and `config.tracker.tools.addComment` non-empty | Post the report as a comment, attach evidence with `config.tracker.tools.uploadAttachment`, apply `config.tracker.passLabel` or `config.tracker.blockedLabel` with `config.tracker.tools.addLabels` per the verdict, then confirm the write back to the user |
| A tracker, but a tool name is empty | Do what is available. For the rest, print the exact text and file paths for the user to paste, and mark those sub-steps `skipped no <tool> configured` |
| `none` | Nothing external to write. `set publish skipped no tracker configured`, then tell the user where the report and evidence are: `<reportsDir>/ABC-123-report.md` and the attachments beside it |

Posting to a tracker is a write to an external system. Ask before the first
write unless the user already approved publishing for this run. The same holds
for pull requests in the fix loop: open them with `config.repo.prCommand`, and
when it is empty, derive the URL from the git remote and print it for the user
instead of guessing at a host's API.

## Toolbox: prefer these scripts over inline one-liners

The installer puts the runtime in `qc/` at the host repo root. Every script
takes `--help`.

```bash
node qc/driver.js <cmd>                 # tap/input/assert/screenshot/swipe/connect/disconnect
node qc/dump-tree.js [--grep x]         # live accessibility tree with enabled state and tap centers
node qc/api.js --health                 # is the configured gateway up? gate for the smoke phase
node qc/api.js --smoke                  # login, then the authenticated read at backend.smokePath
node qc/api.js GET|POST <path>          # authenticated REST against the gateway
node qc/config.js --json                # the resolved config, after defaults are merged
node qc/config.js --reports-dir         # absolute evidence directory, created if missing
node qc/config.js --caps <profile>      # Appium capabilities for android|android_tablet|ios
qc/record.sh start|stop <out.mp4>       # session screen recording, defensive
node qc/state.js ABC-123 get|set|step|plan|finding|reset   # resumable state, sub-step progress, findings log
node qc/cost.js ABC-123 snapshot|get|reset                 # cost tracking, auto-fired by state.js set; `get` for the report
```

Read the driver's output, do not scan it for symbols. It prints `OK:` on
success, `WARN:` when it recovered, `ERROR:` when the command failed, and
`ASSERT FAILED - ...` when an assertion did not hold. An `ASSERT FAILED` line
is test evidence: record the finding and screenshot before moving on.
`QC_SESSION_FILE` overrides where the Appium session record is kept, which
matters when two runs share a machine.

## Eval mode (`QC_EVAL=1`), set by an eval runner, never by hand

An eval harness can drive this skill headlessly to score it against a case
file. When the environment variable `QC_EVAL` is `1`, four things change and
nothing else:

- **`test-plan`**: write the plan exactly as usual, then auto-approve it with
  `node qc/state.js ABC-123 set test-plan pass auto-approved (eval mode)`. Do
  not ask the user anything. Nobody is there to answer and the run would stall.
- **`unit-tests`**: run the existing suites with `config.codeMap.testCommand`,
  but never commit. Mark the `commit` sub-step `skipped eval mode`.
- **`publish`**: skip the whole phase, `set publish skipped eval mode`. The
  `report` phase still assembles `<reportsDir>/ABC-123-report.md` with its
  `## Overall:` line. That file is what the grader reads.
- **Budget**: `QC_BUDGET` is the run's cap. Past it, device commands stop,
  which in headless mode ends the run. Prefer finishing the report over one
  more test case.

Gates, evidence on disk, and the findings log are unchanged. The grader scores
what the run left in `<reportsDir>/`, so persist findings the moment you see
them.
