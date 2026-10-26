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
recollection. Save the assembled report to `<run>/report.md`. It is the
evidence record, attached to the ticket; what gets posted as the comment is the
shorter `review.md` (see below). Cite evidence by its path relative to
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
Tablet/iOS column when those passes ran. FAIL: Expected vs Actual, plus the
baseline verdict from `references/baseline.md`: "new in this PR", "already on
<base>", "worse in this PR", or "baseline not checked (<reason>)". BLOCKED: the
blocker and whose scope it is. A requested form factor that could not be built
or booted is BLOCKED, not a pass. `Repro:` cases come from the code review: a
FAIL there confirms the predicted bug, a PASS disproves it.)

## Definition of Done
| # | Done means | Status |
|---|-----------|:------:|

(the final state of every D-row from the approved plan; bring the plan file's
cells up to date first, because the report's verdict must agree with the plan
board)

## Unit tests
- PASS: extended <Suite> (+N cases), covers <...>, `<config.codeMap.testCommand> <pattern>` green
- YELLOW: <new logic> left to device QC (no unit test), reason
- RED (expected): [QC-REPRO ABC-123] <name> fails with <actual vs expected>, on branch qc-repro/ABC-123-<slug> (red until the bug is fixed; see `references/unit-tests.md`)

## Findings
- RED Backend: <exact status and body of the failing route, e.g. POST /v1/vehicle returns 404 on staging>, needs fix or redeploy
- YELLOW Code quality: <Component> missing testIDs or a11y labels, suggested ids
- YELLOW QC tooling: <driver gap encountered>
- RED App: <bug seen on device>, confirms code-review finding "<short text>"; baseline: new in this PR
- YELLOW Code review, not reproduced: <predicted bug>, TC<n> passed / could not be run (reason)

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

## The review comment (what people actually read)

`report.md` is the evidence record: complete, traceable, full of paths and
case ids. Almost nobody reads it end to end. The comment you post on the ticket
and the pull request is a separate, short document, written for the developer
who has to act on it and the reviewer deciding whether to merge. Write it to
`<run>/review.md` in the same `assemble` sub-step, **after** `report.md`, and
build it only from what `report.md` and the findings log already say. It adds
no new claims.

**Who it is for:** a developer who did not watch the run, reading on a phone
between meetings. They need to know three things in under a minute: does it
work, what must change before merge, and how to see the problem themselves.

**Style rules:**

- **Open with the verdict in one plain sentence,** saying what was tested and
  what works. For example: "Tested on an Android emulator with the staging
  build. The feature works: links open the right product, both when the app is
  open and when it starts from the link." No `PASS`/`FAIL`/`BLOCKED` jargon in
  the first line.
- **One numbered item per problem, most important first.** Give each one a
  short bold title that says what the *user* sees ("The app freezes when there
  is no internet"), not what the code does. Put the priority in brackets after
  the title, using one of these words: `(must fix)`, `(please fix)`,
  `(minor)`, `(heads-up)`.
- **Under each title, at most four short parts:**
  - what happens, from the user's side, in one or two sentences;
  - *How to reproduce:* 1 to 3 numbered steps the developer can follow on
    their own phone, starting from a screen they can find ("Open any category
    list", not "launch with `~plp-screen`"). Include how to force the
    condition in plain words ("turn on airplane mode", "tap Save twice
    quickly"), and end with what to look for. **Required on every must-fix
    item;** optional elsewhere, and leave it out when the title already says
    it all;
  - *Why:* one line naming the cause, with at most one file or function name
    so the developer can find it. Add the baseline verdict at the end of this
    line when it is known: "New in this PR.", "Already on <base>, not caused
    by this PR." or "Also on <base>, but worse in this PR." (see
    `references/baseline.md`). When a failing unit test shows the bug, say
    where in one clause ("a failing test is on branch `qc-repro/...`");
  - *Suggestion:* one line with the fix.
- **Split the list when there is a merge gate:** a "Must fix before merge"
  group first, then "Worth fixing", then a "Waiting on backend" or "Heads-up"
  group for things outside the PR's control. A bug that is already on
  `<base>` goes under "Worth fixing", not "Must fix", unless the PR was meant
  to fix it.
- **Plain words over internal terms.** Say "spinner", "product page", "the
  list mixes up results", not `DialogRoute`, `PdpBloc`, `hasReachedMax`. One
  code identifier per item at most, in backticks, only where it helps someone
  find the code. No test-case ids (`TC7`), DoD ids, run ids, sub-step names,
  evidence paths or cost lines; those stay in `report.md`.
- **Short.** Aim for under about 30 lines, not counting the reproduce steps. If a finding needs more, it belongs
  in `report.md`, and the comment points there.
- **Name only what you observed or verified.** Mark code-review findings you
  did not reproduce on a device as such ("may", "from the code"), and say what
  you could not test and why, in one line.
- **Never include** credentials, tokens, API keys, account identifiers, or
  values copied from `api/` captures. Describe a key by its name and, at most,
  a short prefix.

Template:

```markdown
### QC review

Tested on <device> with the <env> build. **<One sentence: what works.>**

<There are N problems to fix before merging: | A few things to improve:>

**1. <What the user sees>** (must fix)
<What happens, in one or two sentences.>
*How to reproduce:*
1. <Open a screen anyone can find.>
2. <Force the condition, in plain words.>
3. <Do the action; look for the symptom.>
*Why:* <cause, with at most one `file` or `function`>. <New in this PR. | Already on <base>, not caused by this PR. | Also on <base>, but worse in this PR.>
*Suggestion:* <the fix>.

**2. <...>** (minor)
<...>

**Waiting on backend:**
<What is missing on <env>, and what needs a re-test once it lands.>
```

When the run passed with nothing to fix, the comment is two lines: the verdict
sentence and "No issues found." Do not pad it.

## Publish to the ticket (regardless of verdict)

A FAIL or BLOCKED run is *more* useful with its evidence.

**If `config.tracker.kind` is `"none"`, or the tool name for a step is an empty
string, there is nothing to publish to.** Skip the `publish` phase
(`node qc/state.js ABC-123 set publish skipped 'tracker.kind=none'`), leave the
report and its evidence on disk in `<run>/`, and tell the user the run folder,
the `report.md` and `summary.json` paths, plus the one-paragraph verdict. That
is a complete, successful run.

When `config.tracker.rest.enabled` is true (Jira over REST), every step below
goes through `node qc/tracker.js` instead of a tool:
`comment ABC-123 --file <run>/review.md`, `attach ABC-123 <run>/report.md <file>...`
(several files per call is fine), and `labels ABC-123 --add <label> --remove <label>`.

Otherwise the tool names come from the config and you call them as your agent
calls tools (an MCP tool name, a CLI, or an HTTP call, depending on the host):

| Step | Tool | Notes |
|------|------|-------|
| comment | `config.tracker.tools.addComment` | `review.md` as the body, `report.md` attached |
| attachments | `config.tracker.tools.uploadAttachment` | one call per file |
| labels | `config.tracker.tools.addLabels` | verdict-gated, see below |

1. **Review comment.** Call `config.tracker.tools.addComment` with the issue
   key (`ABC-123`) and `<run>/review.md` as the body, not the full report.
   Attach `report.md` in the next step, so anyone who wants the case-by-case
   evidence has it one click away.

2. **Attach the evidence.** Call `config.tracker.tools.uploadAttachment` once per
   file: `<run>/report.md`, the per-case screenshots (the report's Evidence
   column, from `<run>/screenshots/`) and the session recordings in
   `<run>/recordings/`. Attach `api/` files only when a finding needs them.
   Tokens and credentials are redacted, and body values under secret-looking
   keys (`apiKey`, `secret`, `token`, `siteKey`, `{key, value}` config entries
   named like one, plus `config.backend.redactKeys`) are saved as a short
   prefix and length, such as `f8c8…(32)`. That masking goes by key name, so a
   secret under an innocent name still gets through: open each file first and
   never attach one that holds a full key. Note in the sub-step
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
   `review.md` there. If it is empty, tell the user `<run>/review.md` is ready
   to paste, and offer to open the PR URL if they share it. Posting on a pull
   request is an external write: ask first, as for the ticket.

5. **Confirm** in your reply what landed where: the ticket comment and
   attachments (with the link, built from `config.tracker.site` and
   `config.tracker.projectKey` when they are set), the labels applied and
   removed, and the `report.md` and `review.md` paths in the run folder.

## Optional: codify the verified flow for a future e2e suite

Appium drives QC live and adaptively. Most host repos have no committed e2e
runner. When a flow PASSES and the user asks, you may export the exercised steps
as a flow file for their runner of choice using the same testIDs. Note in the
report that it is **generated** and needs a runner wired before CI can use it.
Never make this part of the live QC loop.
