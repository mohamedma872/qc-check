# Configuration

Everything project-specific lives in one file at your repository root:
`qc.config.json`. The skill and the runtime scripts read it. Nothing about
your app is baked into the code.

Create it with `qc-check setup`, then check it with `qc-check doctor`.

A JSON Schema ships alongside it (`qc.config.schema.json`), so editors that
understand `$schema` will complete and validate the keys as you type.

---

## project

```json
"project": {
  "name": "Example App",
  "reportsDir": "qc-reports",
  "locales": ["en"],
  "rtlLocales": []
}
```

| Key | What it controls |
|-----|------------------|
| `name` | Appears in report headers. Nothing else. |
| `reportsDir` | Where run state, screenshots, recordings and the final report are written. Relative to the repo root. Add it to `.gitignore` unless you want evidence in version control. |
| `locales` | Every screen is checked once per locale. A single-locale app just lists one. |
| `rtlLocales` | Locales that render right to left. Listing one here turns on the mirroring and alignment checks. Leave empty and those checks are skipped entirely. |

Because locale strings are language-dependent, the skill prefers test
identifiers over visible text when selecting elements. That is what makes one
test plan work across all your locales.

---

## tracker

```json
"tracker": {
  "kind": "jira",
  "ticketPattern": "[A-Z]+-[0-9]+",
  "site": "your-org.atlassian.net",
  "projectKey": "ABC",
  "tools": {
    "getIssue": "mcp__jira__jira_get_issue",
    "addComment": "mcp__jira__jira_add_comment",
    "addLabels": "mcp__jira__jira_add_labels",
    "uploadAttachment": "mcp__jira__jira_upload_attachment"
  },
  "passLabel": "QC-Agent-Pass",
  "blockedLabel": "BE-Blocking"
}
```

`kind` accepts `jira`, `github` or `none`.

Set `kind` to `none` when you have no tracker or do not want the agent
touching it. The run then takes its acceptance criteria from your prompt,
skips the publish phase, and leaves the finished report on disk. Everything
else is unchanged.

`tools` holds the **names of the tools your agent can call**, not credentials.
The skill never talks to a tracker directly. It asks the host agent to invoke
the named tool, so the same configuration works whether the integration
arrives over MCP, a CLI, or a plugin. An empty string means that capability is
unavailable and the step that needs it is skipped rather than failed.

`ticketPattern` is a regular expression. It is used to pull a ticket id out of
the current branch name and to validate the argument you pass in.

Labels are applied only when they are earned. The pass label requires a PASS
verdict, zero blocking findings, no failed or blocked phase, and an actual
device pass. See [reporting](../skill/references/reporting.md).

---

## agent

```json
"agent": {
  "kind": "claude",
  "command": "",
  "extraArgs": [],
  "headless": false,
  "timeoutMinutes": 180
}
```

Which AI agent `qc-check run` hands the workflow to. The workflow is identical
for all of them, so this only changes the invocation.

| `kind` | Behaviour |
|--------|-----------|
| `claude` | Invokes the `claude` binary |
| `codex` | Invokes the `codex` binary |
| `custom` | Runs `command`. A `{prompt}` placeholder is substituted; without one the prompt arrives on stdin |
| `none` | Invokes nothing. `qc-check prompt` gives you the text to paste |

`extraArgs` is appended to the invocation, which is where a model flag or a
permission flag goes.

`headless` runs without a human: the test plan is auto-approved and publishing
is skipped. Use it for automation, not for work you intend to trust unreviewed.
`--headless` sets it for one run.

`timeoutMinutes` aborts the agent. A full device pass is slow, so do not set it
low. The run is resumable, so a timeout costs progress, not evidence.

---

## repo

```json
"repo": { "defaultBranch": "main", "prCommand": "" }
```

`defaultBranch` is what a feature branch is diffed against to find the code
under test, and the base for any pull request the fix loop opens. Point it at
your release branch when that is what you merge into.

`prCommand` is the command that opens a pull request, such as
`gh pr create --fill`. Leave it empty and the fix loop derives the URL from the
git remote and prints it instead of opening one.

---

## Environments

Your app may have multiple environments: sprint, uat, prod. An environment
is identified by a single name used everywhere it appears: in `app.flavors`,
in `backend.baseUrls`, in the `--env` flag, and in the QC credentials file.

```json
"app": {
  "defaultFlavor": "sprint",
  "build": {
    "android": "yarn android:{flavor}"
  },
  "flavors": {
    "sprint":      { "androidPackage": "com.example.app.sprint" },
    "uat":         { "androidPackage": "com.example.app.uat" },
    "production":  { "androidPackage": "com.example.app" }
  }
},
"backend": {
  "baseUrls": {
    "sprint":      "https://api.example.com/sprint",
    "uat":         "https://api.example.com/uat",
    "production":  "https://api.example.com"
  },
  "protectedEnvs": ["production"]
}
```

Select an environment for a run:

```bash
qc-check run ABC-123 --env uat
```

Or set it globally for the session:

```bash
export QC_ENV=uat
```

The environment name is substituted into `app.build.android` and
`app.build.ios` wherever `{flavor}` appears, so `yarn android:{flavor}`
becomes `yarn android:uat`.

Environments named prod, production, live or release are PROTECTED by default.
Add others to `backend.protectedEnvs` to refuse runs against them without
`--allow-protected`, because QC logs in and can write data.

---

## app and devices

```json
"app": {
  "defaultFlavor": "staging",
  "androidActivity": "com.example.app.MainActivity",
  "envBanner": "",
  "build": { "android": "", "ios": "" },
  "flavors": {
    "staging":    { "androidPackage": "com.example.app.staging", "iosBundleId": "com.example.app.staging" },
    "production": { "androidPackage": "com.example.app",         "iosBundleId": "com.example.app" }
  }
},
"devices": {
  "android":        { "enabled": true,  "avd": "QC_Phone_API36", "udid": "", "deviceName": "Android Phone" },
  "android_tablet": { "enabled": false, "avd": "",               "udid": "", "deviceName": "Android Tablet" },
  "ios":            { "enabled": false, "deviceName": "iPhone 16", "udid": "" },
  "appium":         { "host": "127.0.0.1", "port": 4723, "newCommandTimeout": 900 }
}
```

QC drives one flavor at a time, `app.defaultFlavor`, overridable per run with
the `QC_FLAVOR` environment variable. The flavor must match the build actually
installed on the device.

A device profile with `enabled: false` is reported as **skipped**, never as a
pass. That distinction matters: a form factor you asked for and could not boot
is blocked, not green.

Leave `udid` empty and Appium picks the device. Set it only when several
emulators run at once and you need to pin one. Set `avd` and the emulator is
booted automatically if it is not already running.

`newCommandTimeout` is in seconds and deliberately generous. A QC run
interleaves device commands with reading source files, and a short timeout
kills the session mid-pass, taking the screen recording with it.

`app.build.android` and `app.build.ios` are the commands that build and install
the configured flavor. Leave them empty and the agent asks you before building
anything. `app.envBanner` is the text your non-production builds display; the
first device step asserts it, which catches the case where the emulator is
running yesterday's production build.

### Unusual devices

Any profile accepts a raw `caps` object, merged last over everything derived
from the rest of the configuration:

```json
"android": {
  "enabled": true,
  "avd": "QC_Phone_API36",
  "caps": {
    "appium:waitForQuiescence": false,
    "appium:autoGrantPermissions": null
  }
}
```

This is the escape hatch, so a one-off capability never needs a change to this
tool. A `null` value **removes** a derived capability rather than sending null,
since no Appium capability takes null as a real value.

Useful commands while filling this in:

```bash
emulator -list-avds              # installed Android emulators
adb devices                      # running devices and their serials
xcrun simctl list devices        # iOS simulators
```

---

## backend

```json
"backend": {
  "enabled": true,
  "defaultEnv": "staging",
  "baseUrls": { "staging": "https://api.staging.example.com", "production": "" },
  "healthPath": "/health",
  "auth": {
    "path": "/auth/login",
    "method": "POST",
    "usernameField": "username",
    "passwordField": "password",
    "tokenPath": "data.accessToken",
    "extraBody": {}
  },
  "headers": {},
  "smokePath": "/health"
}
```

This is what lets the skill catch the failure a green screen hides: a feature
that writes data against an endpoint which is not deployed on the environment
you are testing.

| Key | What it controls |
|-----|------------------|
| `healthPath` | Unauthenticated. Answers "is the gateway up at all". |
| `auth.*` | How to obtain a bearer token. `tokenPath` is a dot-path into the login response, so `data.accessToken` reads `response.data.accessToken`. |
| `extraBody` | Constant fields your login endpoint requires beyond username and password. |
| `auth.sessionHeaders` | Header name to response dot-path, for a gateway that issues a per-session fingerprint or CSRF value at login. |
| `headers` | Constant headers every request needs, such as a client id or an API version. Values may contain `{lang}` and `{version}`. |
| `smokePath` | A cheap authenticated GET. Proves a real authenticated round trip, not just that a port is open. |

Set `enabled: false` for an app with no backend of its own. The contract and
smoke phases are then skipped and the run goes straight to the device pass.

The smoke phase is a **hard gate**. Red means emulators never boot, because
booting them against a dead backend wastes minutes and produces findings that
are not about your app.

---

## codeMap

```json
"codeMap": {
  "navigationGlob": "src/navigation/*.tsx",
  "translationsDir": "src/translations",
  "apiServicesGlob": "src/api/services/**",
  "mutationsGlob": "src/hooks/mutations/**",
  "testCommand": "yarn jest",
  "lintCommand": "yarn lint",
  "typecheckCommand": "npx tsc --noEmit --skipLibCheck",
  "testsGitignored": false
}
```

These tell the agent where to look instead of guessing.

`navigationGlob` is how full-sweep mode builds the screen inventory. Point it
at whatever enumerates your routes.

`apiServicesGlob` and `mutationsGlob` are how the contract phase finds the
write a feature performs, so it can check that endpoint before any emulator
boots.

`testsGitignored` covers the case where your test folder is excluded from
version control. Set it true and the skill knows committing a new test needs a
forced add instead of silently doing nothing.

---

## budget and credentials

```json
"budget": { "currency": "USD", "runCap": 30 },
"credentialsFile": "qc.credentials.js"
```

`budget.runCap` is a soft cap for one run, overridable with the `QC_BUDGET`
environment variable. Near the cap the run prefers finishing the report over
running one more test case, so an expensive run still leaves you evidence.

`credentialsFile` names a gitignored file at your repo root. `setup` generates
it with a marker comment on the first line:

```js
// Generated by qc-check. Do not remove this line.
module.exports = {
  "sprint": { "username": "qa-sprint", "password": "..." },
  "uat": { "username": "qa-uat", "password": "..." }
};
```

The file has permissions 0600 (readable and writable only by you). The runtime
scripts read it; **the agent never opens it and never prints its values**. A
credential that reaches a report, a log, or a tracker comment is a defect in
this tool, not a configuration choice.

Add credentials for an environment:

```bash
qc-check env credentials sprint
```

Remove them:

```bash
qc-check env credentials sprint --remove
```

For CI and other headless environments, set `QC_CRED_<ENV>_USERNAME` and
`QC_CRED_<ENV>_PASSWORD` environment variables instead. The environment name
is uppercased with non-alphanumerics turned into underscores. For example:

```bash
export QC_CRED_UAT_USERNAME=qa-uat
export QC_CRED_UAT_PASSWORD=...
```

Environment variables take precedence over the file. Protected environments do
not ask for credentials by default, but you can add them if the protected
environment supports QC access.

---

## Environment variables

These override configuration for a single run.

| Variable | Effect |
|----------|--------|
| `QC_ENV` | Backend environment, overriding `backend.defaultEnv`. |
| `QC_FLAVOR` | App flavor, overriding `app.defaultFlavor`. |
| `QC_BUDGET` | Run cap, overriding `budget.runCap`. |
| `QC_EVAL` | Headless mode. Auto-approves the test plan, never commits, never publishes. Set by an automated runner, not by hand. |

---

## Output

Evidence is organized under `project.reportsDir` (default `qc-reports`):

```
qc-reports/
  index.md, index.json                every run, newest first
  .active.json                        the run in progress, gitignored
  _unsorted/                          artifacts captured with no run
  ABC-123/sprint/                     ticket id and environment
    current                           id of the run a re-run resumes
    2026-09-22T17-03-26Z/             ISO 8601 timestamp per run
      summary.json                    machine-readable result
      report.md  plan.md  state.json  cost.json  cost.md
      screenshots/  recordings/  trees/  api/
  FULL-SWEEP/                         pseudo-ticket for sweeps
    2026-09-22T17-04-00Z/
      summary.json  report.md  plan.md  state.json
      screenshots/  recordings/  trees/  api/
  FULL-SWEEP-FIX/                     fix loop over a sweep
    2026-09-22T17-05-00Z/
```

Fix loops use `<TICKET>-FIX` as the folder. For example, `ABC-123-FIX`.

The `summary.json` file contains the machine-readable result with these fields:

| Field | Content |
|-------|---------|
| `schema` | Version of the summary.json format |
| `ticket` | Ticket id (ABC-123, FULL-SWEEP, or ABC-123-FIX) |
| `environment` | Environment the run targeted (sprint, uat, prod) |
| `runId` | ISO 8601 timestamp when this run started |
| `startedAt`, `updatedAt` | When the run started and last updated |
| `verdict` | PASS, FAIL, BLOCKED or null if not yet complete |
| `phases` | Each phase: name, status, sub-steps |
| `findings` | Object with red count, yellow count, total count |
| `artifacts` | Counts of screenshots, recordings, trees and API responses |
| `app` | Build version, flavor, package id, bundle id |
| `backendUrl` | URL of the backend environment used |
| `costUsd` | Total spend in USD |
| `files` | List of all output files written |

`index.md` and `index.json` list every run with their outcome, newest first. Add
these to git (via `project.commitReports: true`) to track QC history. The
directory keeps recordings, the `.active.json` session file and `_unsorted/`
artifacts in `.gitignore`.

The `project.commitReports` key controls what goes in version control:

| Value | Behaviour |
|-------|-----------|
| false (default) | Gitignore the whole `qc-reports/` directory |
| true | Keep reports, plans, summaries and screenshots; gitignore only `<reportsDir>/**/recordings/`, `<reportsDir>/.active.json` and `<reportsDir>/_unsorted/` |
