# Report + publish (phases `report` + `publish`)

`qc/` is the installed runtime inside the host repo, `<run>/` is this run's folder (it is in your prompt, in `$QC_RUN_DIR`, and
`node qc/runs.js current` prints it), `<env>` is the run's
environment (`QC_ENV`), and `ABC-123` stands for the ticket id.

Sub-steps (record each with `node qc/state.js ABC-123 step <phase> <name> <status>`):

| Phase | Sub-steps |
|-------|-----------|
| `report` | `assemble` |
| `publish` | `comment` -> `attachments` (one step covers all uploads; note which files landed) -> `labels` -> `confirm` |

## The QC report

**Assemble from disk, not from memory.** A resumed run must produce the full
report even if earlier phases ran in a session you never saw. The sources are:

- `node qc/state.js ABC-123 get --json` (phases, sub-step notes, the findings
  log);
- the plan board `<run>/plan.md` (DoD and per-case results);
- the evidence the scripts saved under `<run>/`: `screenshots/`,
  `recordings/`, `trees/` and `api/`, each file numbered in capture order.

The `## Findings` section below is the recorded findings log, not a
recollection. Save the assembled report to `<run>/report.md`, which is also
what gets pasted into the pull request. Cite evidence by its path relative to
`<run>/`, exactly as the script printed it. Do not rename or copy files to make
the paths look nicer. The scripts pick up the `## Overall:` line from
`report.md` into `summary.json`, so keep that heading exactly as below.

```
# QC Report - ABC-123: [Title]
Platforms: Android phone (<config.devices.android.avd>)[ · tablet (<config.devices.android_tablet.avd>) · iOS (<config.devices.ios.deviceName>) if run]
Environment: <env> · Run: <run-id>
Build: v<x.y.z> (<flavor> flavor, <config.app.flavors[flavor].androidPackage>) · Backend: <config.backend.baseUrls[env]>
Account: QC test account for <env> (masked) · Date: [today]
Recordings: recordings/001-phone.mp4[ · recordings/002-tablet.mp4] (attached to the ticket)

## Test cases
| # | Test case | Phone | Evidence |
|---|-----------|:-----:|----------|
| TC1 | ... | PASS / FAIL / BLOCKED | screenshots/004-tc1-saved.png, api/002-tc1-readback.json |

(Numbering mirrors the approved plan, plan.md. Add a
Tablet/iOS column when those passes ran. FAIL: Expected vs Actual. BLOCKED: the
blocker and whose scope it is. A requested form factor that could not be built
or booted is BLOCKED, not a pass.)

## Definition of Done
| # | Done means | Status |
|---|-----------|:------:|

(the final state of every D-row from the approved plan; bring the plan file's
cells up to date first, because the report's verdict must agree with the plan
board)

## Unit tests
- PASS: extended <Suite> (+N cases), covers <...>, `<config.codeMap.testCommand> <pattern>` green
- YELLOW: <new logic> left to device QC (no unit test), reason

## Findings
- RED Backend: <exact status and body of the failing route, e.g. POST /v1/vehicle returns 404 on staging>, needs fix or redeploy
- YELLOW Code quality: <Component> missing testIDs or a11y labels, suggested ids
- YELLOW QC tooling: <driver gap encountered>

## Overall: PASS / FAIL / BLOCKED - [brief verdict + next step]

## Run cost
[the "Run total" line from `node qc/cost.js ABC-123 get`, e.g. "$12.40 - output
143k, fresh input 890k, cache write 1.2M, cache read 4.8M (2 sessions)".
Against the cap from `config.budget.runCap` in `config.budget.currency`. The
full per-phase table stays in cost.md in the run folder; do not paste it
into the report.]
```

Keep whatever status glyphs the plan board uses, as long as plan, state and
report agree.

**Verdict rules:**

- **PASS** only when every case passed: no FAIL, no BLOCKED, and no unverified
  backend contract.
- **FAIL** when a case failed on evidence you observed.
- **BLOCKED** when the environment, the backend or a missing build stopped a
  case. Say whose scope it is.

Be honest. If the backend or the environment blocked a case, say **BLOCKED**
and whose scope it is; never report a pass you did not observe. Never put the
QC account's username, account identifier, password or a full access token in
a report. Mask account identifiers to the last few characters.

## Publish to the ticket (regardless of verdict)

A FAIL or BLOCKED run is *more* useful with its evidence.

**If `config.tracker.kind` is `"none"`, or the tool name for a step is an empty
string, there is nothing to publish to.** Skip the `publish` phase
(`node qc/state.js ABC-123 set publish skipped 'tracker.kind=none'`), leave the
report and its evidence on disk in `<run>/`, and tell the user the run folder,
the `report.md` and `summary.json` paths, plus the one-paragraph verdict. That
is a complete, successful run.

Otherwise the tool names come from the config and you call them as your agent
calls tools (an MCP tool name, a CLI, or an HTTP call, depending on the host):

| Step | Tool | Notes |
|------|------|-------|
| comment | `config.tracker.tools.addComment` | the full report as the body |
| attachments | `config.tracker.tools.uploadAttachment` | one call per file |
| labels | `config.tracker.tools.addLabels` | verdict-gated, see below |

1. **Report comment.** Call `config.tracker.tools.addComment` with the issue key
   (`ABC-123`) and the full report as the body. Lead with
   `QC Agent Report - ABC-123` and end with `Posted automatically by the QC
   agent - Android phone, <env> environment.`

2. **Attach the evidence.** Call `config.tracker.tools.uploadAttachment` once per
   file: the per-case screenshots (the report's Evidence column, from
   `<run>/screenshots/`) and the session recordings in `<run>/recordings/`.
   Attach `api/` files only when a finding needs them; they are redacted, but
   still check. Note in the sub-step
   which files landed. If uploads are unavailable, say so and keep the paths in
   the comment.

3. **Labels (verdict-gated),** with `config.tracker.tools.addLabels`:
   - **`config.tracker.passLabel`** goes on ONLY for a clean PASS (every case
     passed, no fail, no blocked). A missing or unverified backend contract
     counts as BLOCKED: a green UI on a backend that cannot persist the write is
     BLOCKED plus `config.tracker.blockedLabel`, never the pass label. On a FAIL
     or BLOCKED run, also **remove** a stale pass label from a prior run.
   - **`config.tracker.blockedLabel`** goes on when the blocker is a missing
     backend capability. The comment must name exactly what is missing (method,
     path, expected behaviour), the live-probe evidence (status codes), and the
     concrete backend change that would unblock it. Offer to file or link a
     backend ticket for that team.

4. **Pull request.** If `config.repo.prCommand` is set, the same CLI can usually
   comment on a pull request too (for example `gh pr comment`): offer to post
   the report there. If it is empty, the report is saved at
   `<run>/report.md`: tell the user it is ready to paste, and
   offer to open the PR URL if they share it.

5. **Confirm** in your reply what landed where: the ticket comment and
   attachments (with the link, built from `config.tracker.site` and
   `config.tracker.projectKey` when they are set), the labels applied and
   removed, and the `report.md` path in the run folder.

## Optional: codify the verified flow for a future e2e suite

Appium drives QC live and adaptively. Most host repos have no committed e2e
runner. When a flow PASSES and the user asks, you may export the exercised steps
as a flow file for their runner of choice using the same testIDs. Note in the
report that it is **generated** and needs a runner wired before CI can use it.
Never make this part of the live QC loop.
