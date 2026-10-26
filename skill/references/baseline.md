# Baseline: new in this PR, or already on the default branch?

Why: a FAIL tells the developer something is broken. It does not tell them
whether *their PR* broke it. A bug that is already on
`config.repo.defaultBranch` is still worth reporting, but it is not a reason
to block this merge, and the fix may belong to a different ticket. A reviewer
deciding on the merge needs that answer for every must-fix item.

`qc/` is the installed runtime inside the host repo, `<run>/` is this run's
folder, `<base>` is `config.repo.defaultBranch` (or the release branch the
`ticket` phase found the PR targets), and `ABC-123` stands for the ticket id.

## When

For **every device case that FAILs**, once every case of the pass has run on
the PR build and before its `teardown` sub-step (do not swap builds
mid-pass). Skip it for:

- a case that tests a feature the PR adds: there is nothing to compare, the
  verdict is "new in this PR" by construction. Say so in the note;
- a FAIL caused by the backend or the environment (that is BLOCKED, not FAIL);
- eval mode (`QC_EVAL=1`) and runs over `config.budget.runCap`: record
  "baseline not checked (<reason>)" instead.

## How

1. **Build and install the baseline.** Same flavor, same environment, same
   device profile as the PR pass, only the branch changes:
   ```bash
   node qc/build.js prepare --branch <base>
   node qc/build.js run --platform android      # or ios, matching the failed pass
   ```
   Read `node qc/build.js --help` first for what `prepare` does to the
   working tree. Never stash, reset or discard the user's uncommitted
   changes to get a base build; if it needs a clean tree, ask. If the build
   fails, or the build tooling is not installed, record "baseline not
   checked (build failed: <one line>)" and move on.
2. **Re-run only the failed cases,** with the same steps and the same test
   data as the PR pass. Screenshot with a `base-` prefix so the evidence is
   easy to pair: `node qc/driver.js screenshot --name base-tc7-after-scroll`.
   Track each one as a sub-step of the device phase you are in (an unknown
   step name is appended):
   `node qc/state.js ABC-123 step phone baseline-tc7 in_progress`.
3. **Compare and pick one verdict:**

   | Verdict | When |
   |---|---|
   | **new in this PR** | the case passes on `<base>` |
   | **already on `<base>`** | it fails on `<base>` the same way |
   | **worse in this PR** | it fails on `<base>` too, but the PR makes it worse: more often, on more screens, or with a worse symptom (a crash where `<base>` showed a wrong value) |

   The verdict for a case that tests a feature the PR adds is
   "new in this PR".
4. **Record it as a finding note** the moment you know it, citing the
   finding it qualifies:
   ```bash
   node qc/state.js ABC-123 finding yellow "baseline TC7: already on <base> - same wrong list after a failed sort refresh (screenshots/014-base-tc7-after-scroll.png)"
   node qc/state.js ABC-123 step phone baseline-tc7 pass already on <base>
   ```
   Add the verdict to the TC's cell in `<run>/plan.md` too, for example
   `FAIL (already on main)`.
5. **Put the PR build back** before anything else runs on the device
   (`node qc/build.js run --platform android` from the PR branch, or the
   build command the device pass used), and assert `config.app.envBanner`
   again if it is set.

## How the verdict is used

- `report.md`: the test-case table keeps FAIL, and the FAIL note carries the
  verdict.
- `review.md`: every must-fix item states it in one line (see
  `references/reporting.md`). A bug **already on `<base>`** moves out of
  "Must fix before merge" into "Worth fixing", unless the PR was meant to fix
  it; say that in the item.
- The overall verdict does not change: a FAIL is a FAIL whether or not the PR
  introduced it.
