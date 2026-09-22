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
npm install -g qc-check
```

Or run it without installing:

```bash
npx qc-check --help
```

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

## 4. Fill in the test account

`setup` created a credentials file and gitignored it. Open it and put in a real
QC account:

```js
module.exports = {
  env: 'staging',
  staging: { username: 'CHANGE_ME', password: 'CHANGE_ME' },
};
```

This file is the one thing you must edit by hand. It is deliberately not
detected, not prompted for, and never printed.

The agent never reads it. When the workflow needs to log in, it runs
`qc/driver.js input --credential password`, which types the value straight into
the device. Nothing lands in a transcript, a log or a report.

---

## 5. Check the configuration

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

## 6. Verify

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

## 7. First run

Start the Appium server, boot the emulator with your app installed, then:

```bash
qc-check run ABC-123
```

The run stops early and asks you to approve a test plan. That gate is
deliberate. Read the plan, because everything after it is spent driving a
device against those cases.

Other ways to start a run:

```bash
qc-check run                 # derive the ticket from the current branch
qc-check run all             # sweep every screen in every locale
qc-check run fix ABC-123     # fix what the last run found
qc-check run ABC-123 --dry-run   # show what would be executed
```

While it runs, and after:

```bash
qc-check status ABC-123      # phases, sub-steps, findings, resume point
qc-check report ABC-123      # the finished report
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
| Session dies mid-pass | Appium idle timeout too short | Raise `devices.appium.newCommandTimeout` |
| Two repos fighting over one session | Shared session file | Export `QC_SESSION_FILE` per repo |

---

## Optional: start runs from inside your agent

If you would rather type a slash command in an agent session than run a shell
command:

```bash
qc-check install --agent claude    # or codex, or generic
```

This is optional. It installs the same workflow the CLI uses, so the two never
drift apart.
