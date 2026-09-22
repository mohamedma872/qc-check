# Backend contract verification + live smoke test (phases `contract` + `smoke`)

Conventions used in this file:

| Placeholder | Comes from |
|-------------|-----------|
| `qc/` | where the installer put the runtime inside the host repo (`qc-check setup`) |
| `<run>/` | this run's folder: in your prompt, in `$QC_RUN_DIR`, printed by `node qc/runs.js current` |
| `ABC-123` | the ticket id, validated against `config.tracker.ticketPattern` |
| `<env>` | the run's environment: `QC_ENV`, else `config.backend.defaultEnv`. Fixed for the whole run |

**If `config.backend.enabled` is false, set both phases `skipped` and move on.**
The app then has no REST backend to verify, and the device passes are the only
evidence.

## What "the backend" means here

The app talks to its backend over HTTP. `qc/api.js` speaks the same contract
from the host, so you can prove the server half without the app:

| Fact | Config key |
|------|-----------|
| Base URL | `config.backend.baseUrls[<env>]` |
| Login route + method | `config.backend.auth.path`, `config.backend.auth.method` |
| Credential field names | `config.backend.auth.usernameField`, `config.backend.auth.passwordField` |
| Where the token is read from | `config.backend.auth.tokenPath` (dot-path to the bearer token in the login response) |
| Constant login body fields | `config.backend.auth.extraBody` |
| Constant headers on every request | `config.backend.headers` |
| Health probe | `config.backend.healthPath` |
| Cheap authenticated GET | `config.backend.smokePath` |
| Credentials | the `<env>` account, from `QC_CRED_<ENV>_*` or `config.credentialsFile`. `qc/api.js` reads it; you never do |

If the backend issues tokens in a response header rather than the body, prove
`node qc/api.js --token` works before you rely on it, and record a yellow
tooling finding if it does not.

A valid contract is a **deployed route**: method + path + request shape +
response shape. Ticket text is not a contract. The live gateway is.

Warning: some gateways reject any request missing a constant header (for
example `Platform`, `App-Version`, `Device-ID`) with a 400. Those belong in
`config.backend.headers`, and `qc/api.js` then sends them on every call. If you
see that error, it is a raw-curl mistake or a `config.backend.headers` gap, not
a contract gap.

**The installed build and `qc/api.js` must target the same environment.** The
flavor (`QC_FLAVOR`, else the flavor named `<env>`, else
`config.app.defaultFlavor`) decides which package the device runs
(`config.app.flavors[<flavor>].androidPackage` / `.iosBundleId`), and for most
apps the environment is baked in at build time. If they disagree, the app is
talking to a different server than you are and every result is meaningless.
`qc/api.js` already targets `<env>`: never pass it a different `--env`.

**Keep the responses as evidence.** Add `--save <name>` to any `qc/api.js` call
whose answer matters to the verdict. The response is written to
`<run>/api/NNN-<name>.json` with tokens and credential fields redacted, and the
script prints the path. Cite that path in the report. Never redirect output to
a file of your own.

## Phase `contract` - verify the app-to-backend handshake

Why: a feature can have a perfect UI and still be half-built. The value the
user picks never reaches or persists on the backend. This catches "UI done, BE
missing" **before** you label anything verified. Skip only for purely
presentational features (no create/update/delete, nothing sent to the server).

Sub-steps (record each with `node qc/state.js ABC-123 step contract <name> <status>`):
`identify-write` -> `be-ref` -> `live-check` -> `verdict`, items 1 to 4 below in
order.

1. **Identify the write the feature performs.** From the PR code (the branch
   under test diffed against `config.repo.defaultBranch`), find the
   service call and the exact method + path + request body it sends. Check both
   the service layer (`config.codeMap.apiServicesGlob`) and the mutation hook
   that builds the payload (`config.codeMap.mutationsGlob`). Write down the
   precise contract the app depends on (for example *"POST `/v1/vehicle`
   accepting `{makeId, modelId, year}` and persisting it"*), plus any response
   field the app reads afterwards.

2. **Find the backend reference for this ticket.** The server code usually
   lives in another repo you cannot read from here, so the ticket is the trail:
   check linked issues, sub-tasks and "blocked by" relations with
   `config.tracker.tools.getIssue` for the backend ticket and its status. A
   backend ticket that is not Done/Deployed predicts a failing live-check, so
   note it. If `config.tracker.kind` is `"none"` (or the tool name is empty),
   there is nothing to query: ask the user whether the backend work shipped and
   record the answer as the sub-step note. **The live gateway (next step) is the
   authority** for "what the backend has now", not ticket text.

3. **Cross-check the LIVE deployed gateway.** Confirm the route is deployed on
   the QC environment. Probe without side effects:
   ```bash
   # Route existence, no login needed. The status code is the answer:
   node qc/api.js --unauth GET '/v1/<path>' --save contract-unauth      # 401/403 = deployed, auth wall
   # Authenticated read of the endpoint the screen uses:
   node qc/api.js GET '/v1/<path>' --save contract-read
   # Write route existence, EMPTY body only (validation must reject it):
   node qc/api.js POST '/v1/<path>' --data '{}' --save contract-write   # 400/422 = deployed, validation ran
   ```
   Read the status code like this:
   - **404 / 405** -> route (or method) **missing on this gateway**. The
     contract is not deployed.
   - **401 / 403** -> route deployed, auth/permission wall answered.
   - **400 / 422** -> route deployed, validation ran.
   - **2xx** -> deployed and answering.

   Never probe destructive writes (DELETE, state-changing POST/PUT) with real
   payloads outside the QC account's own data. Empty or invalid bodies only,
   until the smoke phase does the real round-trip deliberately.

4. **Contract verdict, which gates the whole PR:**
   - **Present** - the route exists *and is deployed on the QC gateway*. You
     will prove the round-trip on-device in the device phases (write, then read
     back via the API).
   - **Missing** - the app depends on a route or field the deployed backend does
     not expose. The write-path test case is **BLOCKED**, not pass. Record the
     exact gap as a red finding:
     ```bash
     node qc/state.js ABC-123 finding red 'POST /v1/vehicle returns 404 on <env> - contract not deployed'
     ```
     and plan the `config.tracker.blockedLabel` label for the publish phase. Do
     not hand-wave persistence as "out of scope" to reach a green pass.

The approved test plan (`<run>/plan.md`) must already have an
explicit **end-to-end persistence** test-case row for every write the feature
performs (for example *"save vehicle -> GET readback -> backend returns the
saved vehicle"*), verified by reading state back from the API, not by the UI
looking right. If contract work reveals a write the plan missed, append its TC
and DoD row marked *(added post-approval)* and tell the user in the status
one-liner.

## Phase `smoke` - backend live smoke test (HARD GATE for all device phases)

Booting emulators, building and logging in costs many minutes. If the backend is
down the app fails everywhere for reasons unrelated to the PR. Prove the backend
first.

Sub-steps (record each with `node qc/state.js ABC-123 step smoke <name> <status>`):
`health` -> `auth` -> `roundtrip` -> `verdict`, items 1 to 4 below in order.

1. **Health:**
   ```bash
   node qc/api.js --health    # probes config.backend.healthPath; any HTTP < 500 = up; non-zero exit if down
   ```
   Down -> **STOP. Do not boot emulators.** Report "QC blocked: `<env>` gateway
   down", set `node qc/state.js ABC-123 set smoke blocked`, and offer to retry or
   poll. This is an environment outage, not a PR finding. If the gateway is only
   reachable on a VPN or an office network, a health failure can also mean you
   are off it: say so rather than declaring an outage.

2. **Auth:**
   ```bash
   node qc/api.js --token | head -c 12   # prints a token prefix; auth failure = backend erroring or QC account broken -> STOP
   ```
   Login is `config.backend.auth.method` on `config.backend.auth.path` with the
   `<env>` account. `qc/api.js` finds it by itself. If it says there are no
   credentials for `<env>`, set `smoke blocked`, stop, and ask the user to run
   `qc-check env credentials <env>` (or set `QC_CRED_<ENV>_USERNAME` and
   `_PASSWORD` in CI). Never print the credential values, and never paste a
   full token into a report or a ticket.

3. **Feature round-trip ON THE SERVER.** Prove the backend half without the app,
   so a later device failure can only be the app:
   - **Read feature** - run the request the screen issues and confirm the data
     plus the fields the UI renders are non-null:
     ```bash
     node qc/api.js GET /v1/<the-screen-endpoint> --save smoke-read
     ```
   - **Write feature** - perform the write through `qc/api.js` **on the QC
     account's own data**, then read it back and confirm persistence. If the
     write needs a state the QC account is not in (for example a step in a flow
     it has not reached), note it now and plan how the device pass will set it
     up. Do not discover it on-device. Save the write and the readback with
     `--save smoke-write` and `--save smoke-readback`.
   - **Localized responses** - if `config.project.locales` has more than one
     entry and the ticket involves localized content, repeat the read once per
     locale with `--lang <locale>` and confirm each payload.

4. **Smoke verdict:**
   - Alive and round-trip proven -> `node qc/state.js ABC-123 set smoke pass`,
     proceed to the device phases, and reuse these requests to verify on-device
     writes server-side.
   - Down, auth failing, or round-trip broken -> `node qc/state.js ABC-123 set
     smoke blocked`, **STOP before any emulator**, and report the precise
     failure. For a deployed contract gap also apply `config.tracker.blockedLabel`
     (see `reporting.md`).
