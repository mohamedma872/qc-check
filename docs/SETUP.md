# Setup

From nothing to a first QC run. Budget about 20 minutes the first time, most
of it installing Appium and booting an emulator.

Every step ends with something you can verify, so you find out immediately when
a piece is missing rather than ten minutes into a device run.

---

## 1. Prerequisites

| You need | Why | Check it |
|----------|-----|----------|
| Node 18 or newer | Runs the CLI and the device scripts | `node --version` |
| Appium 2 and a driver | Drives the real app | `appium --version` |
| An Android emulator or iOS simulator | Somewhere to run the app | `emulator -list-avds` |
| A build of your app installed on it | The thing under test | it launches by hand |
| An AI agent CLI | Executes the workflow | `claude --version` or `codex --version` |

An agent CLI is optional. Without one, `qc-check prompt` gives you the prompt
to paste into whatever agent you use.

### Appium

```bash
npm install -g appium
appium driver install uiautomator2      # Android
appium driver install xcuitest          # iOS, macOS only
```

Leave a server running in its own terminal while you QC:

```bash
appium --port 4723
```

### Android

You need the platform tools and an emulator on your `PATH`. Confirm with:

```bash
emulator -list-avds     # lists installed emulators
adb devices             # lists running ones
```

Create a dedicated emulator for QC rather than sharing the one you develop on.
A QC run boots it, installs a build and drives it for a long time, which is
disruptive if it is also your working device.

### iOS

macOS only, with Xcode installed.

```bash
xcrun simctl list devices available
```

---

## 2. Install the CLI

```bash
curl -fsSL https://raw.githubusercontent.com/mohamedma872/qc-check/main/install.sh | sh
```

That downloads the tool to `~/.qc-check` and links `qc-check` into the first
writable bin directory on your PATH, preferring `~/.local/bin`. Nothing goes
anywhere system-wide and no sudo is involved. If the bin directory is not on
your PATH yet, the installer prints the line to add to your shell profile.

Confirm it:

```bash
qc-check --version
```

### Other ways to install

| You want | Do this |
|----------|---------|
| To read the code before running it | `git clone https://github.com/mohamedma872/qc-check.git` then `./qc-check/qc-check --help`. A clone runs as-is |
| It somewhere specific | `sh install.sh --prefix ~/bin` |
| A fixed version | `sh install.sh --ref v1.2.0` |
| To update | `sh install.sh --update`, or `git pull` in a clone |
| To remove it | `sh install.sh --uninstall`. Your config, `qc/` and reports stay |

The only requirement is Node 18 or newer, because the CLI and the device
scripts are JavaScript. There is no npm install step and no build step.

---

## 3. Configure your repository

From the root of the app you want to QC:

```bash
qc-check setup
```

This inspects the repository and asks only about what it cannot work out. It
detects your stack, your Android package id and launcher activity, your iOS
bundle id, your build, test and lint commands, your source layout, your
locales, the emulators installed on this machine, and which agent CLIs you
have.

It writes four things:

| What | Where | Committed |
|------|-------|-----------|
| Configuration | `qc.config.json` | yes, it describes the project |
| Credentials template | `qc.credentials.js` | no, gitignored for you |
| Device scripts | `qc/` | yes |
| Ignore rules | `.gitignore` | yes |

Run it again any time. It preserves values you edited by hand.

Non-interactive, for a container or a script:

```bash
qc-check setup --yes
```

---

## 4. Environments and test accounts

`setup` created a credentials file and gitignored it. For each environment your
app supports (sprint, uat, prod), it asks you for a base URL and optionally a
QC username and password. The password is typed hidden (asterisks).

Credentials live in `qc.credentials.js`, which you can edit by hand or manage
with commands:

```js
module.exports = {
  "sprint": { "username": "qa-sprint", "password": "..." },
  "uat": { "username": "qa-uat", "password": "..." }
};
```

This file is marked with a comment on the first line and has file permissions 0600.
If you hand-wrote it (no marker), qc-check never modifies it and says so.

Change credentials later with:

```bash
qc-check env credentials sprint
qc-check env credentials sprint --remove
```

For CI, set environment variables instead: `QC_CRED_<ENV>_USERNAME` and
`QC_CRED_<ENV>_PASSWORD`, where `<ENV>` is the environment name uppercased with
non-alphanumerics turned into underscores. For example, `QC_CRED_UAT_USERNAME`.
The environment variables win over the file.

Environments named prod, production, live or release, plus any listed in
`backend.protectedEnvs` in the config, are PROTECTED. A run against them is
refused unless you pass `--allow-protected`, because a QC run logs in and can
write data.

Protected environments do not ask for credentials by default. Provide them if
your protected environment needs QC access.

The agent never reads the credentials file. When the workflow needs to log in,
it runs `qc/driver.js input --credential password`, which types the value
straight into the device. Nothing lands in a transcript, a log or a report.

---

## 5. Where the output goes

Evidence is organized under `project.reportsDir` (default `qc-reports`):

```
qc-reports/
  index.md, index.json              every run, newest first
  .active.json                      the run in progress, gitignored
  _unsorted/                        artifacts with no run in progress
  ABC-123/sprint/
    current                         id of the run a re-run resumes
    2026-09-22T17-03-26Z/           one run
      summary.json                  machine-readable outcome
      report.md  plan.md  state.json  cost.json  cost.md
      screenshots/                  numbered like 001-login.png
      recordings/  trees/  api/
  FULL-SWEEP/
    2026-09-22T17-04-00Z/           sweep run
```

The configuration key `project.commitReports` controls what goes in git:
- false (default) gitignores the whole `qc-reports` directory
- true keeps reports, plans, summaries and screenshots in git and ignores only
  `<reportsDir>/**/recordings/`, `<reportsDir>/.active.json` and
  `<reportsDir>/_unsorted/`

`summary.json` contains the machine-readable result: schema version, ticket id,
environment, runId, when it started and when it last updated, the verdict
(PASS/FAIL/BLOCKED or null), phases with their results, findings counts (red,
yellow, total), artifact counts (screenshots, recordings, trees, api calls),
app info, backend URL, spend in USD, and the list of files written.

---

## 6. Check the configuration

Open `qc.config.json` and confirm the parts `setup` could not detect. The full
key reference is in [CONFIGURATION.md](CONFIGURATION.md); these are the ones
that usually need a human.

**Backend.** If your app has one, this is what catches a feature whose endpoint
is not deployed on the environment you are testing:

```json
"backend": {
  "enabled": true,
  "defaultEnv": "staging",
  "baseUrls": { "staging": "https://api.staging.example.com" },
  "healthPath": "/health",
  "auth": {
    "path": "/auth/login",
    "usernameField": "username",
    "passwordField": "password",
    "tokenPath": "data.accessToken"
  },
  "smokePath": "/health"
}
```

`tokenPath` is a dot-path into the login response. Set `enabled` to `false` if
your app has no backend of its own.

**Tracker.** Leave `kind` as `none` and QC takes the acceptance criteria from
your prompt and leaves the report on disk. Point it at a tracker and it fetches
the ticket and publishes the report:

```json
"tracker": {
  "kind": "jira",
  "site": "your-org.atlassian.net",
  "projectKey": "ABC",
  "tools": { "getIssue": "mcp__jira__jira_get_issue", "addComment": "mcp__jira__jira_add_comment" }
}
```

`tools` holds the names of tools **your agent** can call, not credentials.

**Agent.**

```json
"agent": { "kind": "claude", "headless": false, "timeoutMinutes": 180 }
```

`kind` is `claude`, `codex`, `custom` or `none`. For `custom`, set `command`
and use a `{prompt}` placeholder, or the prompt arrives on stdin.

---

## 7. Verify

```bash
qc-check doctor
```

It checks every piece and names the fix for anything missing. It exits non-zero
while something is wrong, so it works in a script.

```
  ok    node 20.19.4
  ok    qc.config.json parses
  ok    runtime installed at qc/
  ok    device profiles: android
  ok    android: emulator QC_Phone_API36 exists
  ok    appium reachable at 127.0.0.1:4723
  ok    credentials file present: qc.credentials.js
  ok    agent: claude

Ready to run: qc-check run ABC-123
```

---

## 8. First run

Start the Appium server, boot the emulator with your app installed, then:

```bash
qc-check run ABC-123
```

The run stops early and asks you to approve a test plan. That gate is
deliberate. Read the plan, because everything after it is spent driving a
device against those cases.

To test against a specific environment (for example uat instead of the default):

```bash
qc-check run ABC-123 --env uat
```

Other ways to start a run:

```bash
qc-check run                 # derive the ticket from the current branch
qc-check run all             # sweep every screen in every locale
qc-check run fix ABC-123     # fix what the last run found
qc-check run ABC-123 --dry-run   # show what would be executed
```

While it runs, and after:

```bash
qc-check status ABC-123                 # phases, sub-steps, findings, resume point
qc-check status ABC-123 --env uat       # status for a specific environment
qc-check report ABC-123                 # the finished report
qc-check report ABC-123 --env uat       # report for a specific environment
qc-check report ABC-123 --json          # summary.json instead of markdown
```

Stop a run whenever you like. State is written to disk after every step, so
`qc-check run ABC-123` resumes at the sub-step it stopped on instead of
starting over.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `no qc.config.json found` | Not in the app repo, or setup never ran | `cd` to the repo root and run `qc-check setup` |
| `no Appium server at 127.0.0.1:4723` | Server not running | `appium --port 4723` in another terminal |
| `devices.android.avd ... is not installed` | Config names an emulator this machine lacks | `emulator -list-avds` and update the key |
| Agent binary not on PATH | Agent CLI not installed | Install it, or set `agent.kind` to `none` and use `qc-check prompt` |
| Run stops at the smoke phase | The backend is down or unreachable | Intended. A dead backend stops the run before emulators boot |
| Login fails on device | Credentials file missing or unfilled | Fill `qc.credentials.js`; `doctor` reports presence only |
| No credentials stored for an environment | Credentials file does not have that environment | `qc-check env credentials <env>` to add them, or set `QC_CRED_<ENV>_USERNAME` and `QC_CRED_<ENV>_PASSWORD` |
| Session dies mid-pass | Appium idle timeout too short | Raise `devices.appium.newCommandTimeout` |
| Two repos fighting over one session | Shared session file | Export `QC_SESSION_FILE` per repo |
| `refused: the target environment is protected` | Run targets prod, production, live or release, or an environment in `backend.protectedEnvs` | Pass `--allow-protected` if you really mean to QC that environment |
| `gateway is BLOCKED` | An edge proxy answered with its own HTML page, so the request never reached the API | On a VPN-only environment, connect the VPN. This is not a pass |
| `something is listening ... but it is not Appium` | Another process holds the Appium port | `lsof -iTCP:4723 -sTCP:LISTEN`, stop it, start Appium |
| Evidence landing in `_unsorted/` instead of a run folder | No run was in progress when the scripts captured an artifact | Restart the run or ensure `qc-check run` or `qc-check status` completed successfully |
| `this screenshot looks blank` | Emulator GPU rendering that screen capture cannot read | Restart the emulator with `-gpu swiftshader_indirect` |
| A tap reports OK but nothing changes | Usually a stale tree read before the screen settled | Screenshot after every tap and compare; the driver already touches the parent of a non-clickable label |

---

## Optional: start runs from inside your agent

If you would rather type a slash command in an agent session than run a shell
command:

```bash
qc-check install --agent claude    # or codex, or generic
```

This is optional. It installs the same workflow the CLI uses, so the two never
drift apart.
