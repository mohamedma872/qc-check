'use strict';

// qc-check prompt <target>
//
// Assembles the QC prompt and prints it. This is the escape hatch for an
// agent the CLI cannot launch: pipe it, paste it, or feed it to anything that
// takes a prompt on stdin. It never invokes anything.
//
// run.js reuses buildPrompt() so there is exactly one assembly in the repo.

const fs = require('fs');
const path = require('path');

const {
  PKG_ROOT,
  RUNTIME_DIR,
  CONFIG_FILE,
  info,
  fail,
  findHost,
  readConfig,
  reportsDirOf,
  credentialsPathOf,
} = require('./util');
const { resolveEnv, guardProtected, runKey, peekRun, buildFor, isProtected } = require('./envs');

// The phase documents SKILL.md tells the agent to read when it gets there.
const REFERENCES = [
  ['test-plan', 'test-plan.md'],
  ['contract / smoke', 'backend-contract.md'],
  ['phone / tablet / ios', 'device-driving.md'],
  ['unit-tests', 'unit-tests.md'],
  ['report / publish', 'reporting.md'],
  ['full sweep mode', 'full-sweep.md'],
  ['fix loop mode', 'fix-loop.md'],
];

// ------------------------------------------------------------------ target

// Turn positionals into the one thing the workflow needs to be told.
function resolveTarget(positionals) {
  const list = (positionals || []).filter(Boolean).map(String);
  const first = (list[0] || '').toLowerCase();

  if (first === 'fix') {
    return { mode: 'fix', id: (list[1] || '').toUpperCase(), label: `fix ${(list[1] || '').toUpperCase()}` };
  }
  if (first === 'all' || first === 'full' || first === 'sweep') {
    return { mode: 'sweep', id: 'FULL-SWEEP', label: 'full-app sweep' };
  }
  if (list[0]) {
    const id = list[0].toUpperCase();
    return { mode: 'ticket', id, label: id };
  }
  return null;
}

function targetSection(target) {
  if (target.mode === 'sweep') {
    return [
      '## Your target: full-app sweep',
      '',
      'The argument is `all`. Run the workflow in full-app sweep mode:',
      'read the `full-sweep.md` reference FIRST, use the pseudo-ticket',
      '`FULL-SWEEP` for all state and evidence file names, build the screen',
      'inventory instead of fetching a ticket, use the per-screen checklist as',
      'the test plan, and skip the contract and unit-test phases.',
    ].join('\n');
  }
  if (target.mode === 'fix') {
    return [
      `## Your target: fix loop for ${target.id}`,
      '',
      `The argument is \`fix ${target.id}\`. Read the \`fix-loop.md\` reference`,
      `FIRST, then take the findings of run ${target.id} and loop triage,`,
      'root-cause, fix, re-verify on device, push and PR until every app-side',
      'finding is closed. Backend-side findings stay reported, not fixed.',
    ].join('\n');
  }
  return [
    `## Your target: ${target.id}`,
    '',
    `QC ticket ${target.id}. Use it for every state, plan, evidence and report`,
    `file name, starting with \`node ${RUNTIME_DIR}/state.js ${target.id} get\``,
    'to pick up a run that may already be part-done.',
  ].join('\n');
}

// ------------------------------------------------------------------ config

// A published prompt must never carry a secret, so anything that reads like a
// credential is named but not valued.
const SECRET_KEY = /(pass|secret|token|key|cred|bearer|cookie|session|auth|signature|sig|otp)/i;

function safeValue(key, value) {
  if (value === undefined || value === null || value === '') return '';
  if (SECRET_KEY.test(String(key))) return '[set, value withheld]';
  return String(value);
}

function line(out, label, value, width) {
  if (value === undefined || value === null || value === '') return;
  out.push(`  ${String(label).padEnd(width)}  ${value}`);
}

function renderMap(obj, redactValues) {
  const keys = Object.keys(obj || {});
  if (keys.length === 0) return '';
  return keys
    .map((k) => `${k}=${redactValues ? safeValue(k, obj[k]) || '(empty)' : obj[k]}`)
    .join(', ');
}

function enabledProfiles(cfg) {
  const devices = (cfg && cfg.devices) || {};
  const out = [];
  for (const name of ['android', 'android_tablet', 'ios']) {
    const p = devices[name];
    if (!p || p.enabled !== true) continue;
    const bits = [];
    if (p.deviceName) bits.push(p.deviceName);
    if (p.avd) bits.push(`avd ${p.avd}`);
    if (p.udid) bits.push(`udid ${p.udid}`);
    out.push({ name, detail: bits.join(', ') });
  }
  return out;
}

function configSection(host, cfg, env) {
  const W = 22;
  const out = [];
  const project = cfg.project || {};
  const tracker = cfg.tracker || {};
  const app = cfg.app || {};
  const backend = cfg.backend || {};
  const codeMap = cfg.codeMap || {};
  const repo = cfg.repo || {};
  const budget = cfg.budget || {};
  const appium = (cfg.devices && cfg.devices.appium) || {};

  out.push('## Resolved configuration');
  out.push('');
  out.push(`These are the live values from ${path.join(host, CONFIG_FILE)}.`);
  out.push('Read that file directly whenever you need a value not listed here.');
  out.push('Nothing credential-shaped is reproduced below, by design.');
  out.push('');

  out.push('Project');
  line(out, 'name', project.name, W);
  line(out, 'repository root', host, W);
  line(out, 'reports dir', reportsDirOf(host, cfg), W);
  line(out, 'locales', (project.locales || ['en']).join(', '), W);
  line(out, 'RTL locales', (project.rtlLocales || []).join(', ') || 'none', W);
  line(out, 'budget cap', budget.runCap ? `${budget.runCap} ${budget.currency || 'USD'}` : '', W);
  out.push('');

  out.push('Devices enabled (a profile not listed here is disabled and cannot run)');
  const profiles = enabledProfiles(cfg);
  if (profiles.length === 0) out.push('  (none enabled)');
  for (const p of profiles) line(out, p.name, p.detail || 'enabled', W);
  line(out, 'appium', `http://${appium.host || '127.0.0.1'}:${appium.port || 4723}`, W);
  line(out, 'newCommandTimeout', appium.newCommandTimeout ? `${appium.newCommandTimeout}s` : '', W);
  out.push('');

  out.push('App under test');
  const flavor = (app.flavors || {})[env] ? env : app.defaultFlavor || env;
  const flavorCfg = (app.flavors || {})[flavor] || {};
  line(out, 'flavor', flavor, W);
  line(out, 'android package', flavorCfg.androidPackage, W);
  line(out, 'ios bundle id', flavorCfg.iosBundleId, W);
  line(out, 'android activity', app.androidActivity, W);
  line(out, 'env banner', app.envBanner || '(none set: verify the flavor another way)', W);
  line(out, 'build android', buildFor(cfg, 'android', env) || '(none: ask before building)', W);
  line(out, 'build ios', buildFor(cfg, 'ios', env) || '(none: ask before building)', W);
  out.push('');

  if (backend.enabled === false) {
    out.push('Backend');
    out.push('  disabled: skip the contract and smoke phases and say so in the report.');
  } else {
    out.push(`Backend (environment: ${env})`);
    line(out, 'base url', (backend.baseUrls || {})[env] || '(not configured)', W);
    line(out, 'health path', backend.healthPath, W);
    line(out, 'smoke path', backend.smokePath, W);
    const auth = backend.auth || {};
    line(out, 'login', auth.path ? `${auth.method || 'POST'} ${auth.path}` : '', W);
    line(out, 'login fields', [auth.usernameField, auth.passwordField].filter(Boolean).join(' / '), W);
    line(out, 'token path', auth.tokenPath, W);
    const headers = renderMap(backend.headers, true);
    line(out, 'constant headers', headers, W);
    out.push(`  ${'credentials'.padEnd(W)}  resolved by the runtime for "${env}". Type them with`);
    out.push(`  ${''.padEnd(W)}  node qc/driver.js input --selector <id> --credential username|password.`);
    out.push(`  ${''.padEnd(W)}  Never open ${path.basename(credentialsPathOf(host, cfg))} and never read QC_CRED_* variables.`);
  }
  out.push('');

  out.push('Tracker');
  line(out, 'kind', tracker.kind || 'none', W);
  line(out, 'site', tracker.site, W);
  line(out, 'project key', tracker.projectKey, W);
  line(out, 'ticket pattern', tracker.ticketPattern || '[A-Z]+-[0-9]+', W);
  const tools = tracker.tools || {};
  for (const t of ['getIssue', 'addComment', 'addLabels', 'uploadAttachment']) {
    line(out, `tool ${t}`, tools[t] || '(none: that step is skipped)', W);
  }
  line(out, 'pass label', tracker.passLabel, W);
  line(out, 'blocked label', tracker.blockedLabel, W);
  out.push('');

  out.push('Repository');
  line(out, 'default branch', repo.defaultBranch || 'main', W);
  line(out, 'pr command', repo.prCommand || '(none: derive the URL from the git remote and print it)', W);
  out.push('');

  out.push('Code map');
  line(out, 'source dir', codeMap.sourceDir || 'src', W);
  line(out, 'navigation', codeMap.navigationGlob, W);
  line(out, 'translations', codeMap.translationsDir, W);
  line(out, 'api services', codeMap.apiServicesGlob, W);
  line(out, 'mutations', codeMap.mutationsGlob, W);
  line(out, 'queries', codeMap.queriesGlob, W);
  line(out, 'utils', codeMap.utilsGlob, W);
  line(out, 'validation', codeMap.validationGlob, W);
  line(out, 'test command', codeMap.testCommand, W);
  line(out, 'lint command', codeMap.lintCommand, W);
  line(out, 'typecheck command', codeMap.typecheckCommand, W);
  line(out, 'tests gitignored', codeMap.testsGitignored ? 'yes: commit tests with git add -f' : 'no', W);

  return out.join('\n');
}

// ------------------------------------------------------------------ layout

// SKILL.md ships with the package; an installer may also have copied the
// references into the host repo. Prefer a host copy so the agent reads files
// it can see beside the code, and fall back to the package.
function workflowFile() {
  return path.join(PKG_ROOT, 'skill', 'SKILL.md');
}

function referencesDir(host) {
  const candidates = [
    path.join(host, '.claude', 'skills', 'qc-check', 'references'),
    path.join(host, 'qc-check-skill', 'references'),
    path.join(host, RUNTIME_DIR, 'references'),
    path.join(PKG_ROOT, 'skill', 'references'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return path.join(PKG_ROOT, 'skill', 'references');
}

function environmentSection(cfg, env, runDir, runRoot) {
  const out = [];
  out.push('## Environment');
  out.push('');
  out.push(`This run targets exactly one environment: ${env}${isProtected(cfg, env) ? ' (PROTECTED: explicitly allowed for this run)' : ''}.`);
  out.push('The build, the backend and the test account all follow it. Never switch');
  out.push('environments mid-run, and state the environment in the report header.');
  out.push('');
  out.push(`Every qc/ command must run with QC_ENV=${env}. If \`echo $QC_ENV\` does not print`);
  out.push(`${env}, prefix each command: \`QC_ENV=${env} node qc/state.js ...\`.`);
  out.push('');
  out.push('## Where evidence goes');
  out.push('');
  if (runDir) {
    out.push(`Run folder: ${runDir}`);
  } else {
    out.push(`Run folder: created under ${runRoot}/ by the first \`node qc/state.js <ID> ...\`.`);
  }
  out.push('`node qc/runs.js current` prints it at any time. Inside it:');
  out.push('');
  out.push('  plan.md          you write it (test plan)');
  out.push('  report.md        you write it, with the "## Overall: PASS|FAIL|BLOCKED" line');
  out.push('  state.json       qc/state.js keeps it');
  out.push('  summary.json     qc/state.js keeps it: machine-readable outcome');
  out.push('  cost.json/.md    qc/cost.js keeps them');
  out.push('  screenshots/     qc/driver.js screenshot --name <label>');
  out.push('  recordings/      qc/record.sh start|stop <label>');
  out.push('  trees/           qc/dump-tree.js --save <label>');
  out.push('  api/             qc/api.js ... --save <label> (redacted)');
  out.push('');
  out.push('Evidence files are numbered and placed by the scripts. Do not invent');
  out.push('paths for evidence and do not write anywhere else under the reports dir.');
  return out.join('\n');
}

function layoutSection(host, cfg) {
  const refs = referencesDir(host);
  const out = [];
  out.push('## Where everything is');
  out.push('');
  out.push(`Work from the repository root: ${host}`);
  out.push(`Run every \`node ${RUNTIME_DIR}/...\` command from there.`);
  out.push('');
  out.push('Runtime scripts (each takes --help):');
  for (const f of ['driver.js', 'dump-tree.js', 'api.js', 'config.js', 'state.js', 'cost.js', 'runs.js']) {
    out.push(`  ${path.join(host, RUNTIME_DIR, f)}`);
  }
  out.push(`  ${path.join(host, RUNTIME_DIR, 'record.sh')}`);
  out.push('');
  out.push('Phase references. They are NOT included above: read each one with');
  out.push('your file-reading tool when you reach that phase, and not before.');
  const width = Math.max(...REFERENCES.map((r) => r[0].length));
  for (const [phase, file] of REFERENCES) {
    out.push(`  ${phase.padEnd(width)}  ${path.join(refs, file)}`);
  }
  return out.join('\n');
}

function headlessSection() {
  return [
    '## Headless run: eval-mode rules are in force',
    '',
    'Nobody is watching this run, so the workflow behaves as it does under',
    '`QC_EVAL=1`. Treat that environment variable as set:',
    '',
    '- test-plan: write the plan exactly as usual, then auto-approve it with',
    '  `node qc/state.js <ID> set test-plan pass auto-approved (eval mode)`.',
    '  Never ask a question and never wait for an answer.',
    '- unit-tests: run the suites, but never commit. Mark the `commit`',
    '  sub-step `skipped eval mode`.',
    '- publish: skip the whole phase, `set publish skipped eval mode`. The',
    '  report phase still assembles the report file with its `## Overall:` line.',
    '- Make no other external write: no tracker comment, no push, no PR.',
    '',
    'Gates, evidence on disk and the findings log are unchanged. Persist every',
    'finding the moment you see it: the run is judged by what is on disk.',
  ].join('\n');
}

// ---------------------------------------------------------------- assembly

// The single assembly used by both `qc-check prompt` and `qc-check run`.
function buildPrompt({ host, cfg, target, headless, env, runDir }) {
  const theEnv = env || resolveEnv(cfg);
  const peek = peekRun(host, cfg, runKey(target), theEnv);
  const wf = workflowFile();
  if (!fs.existsSync(wf)) {
    fail(`the workflow file is missing from the installed package: ${wf}`);
  }
  const workflow = fs.readFileSync(wf, 'utf8').trim();

  const parts = [];
  parts.push(
    [
      `# Task: QC run - ${target.label} on ${theEnv}`,
      '',
      'You are running a device-level QC pass on the mobile app in this',
      `repository, target ${target.label}. The complete workflow follows. It is`,
      'authoritative: follow its phases, gates and evidence rules exactly, and',
      'use the runtime scripts it names instead of inventing one-liners.',
    ].join('\n'),
  );
  parts.push(['---- BEGIN QC WORKFLOW ----', '', workflow, '', '---- END QC WORKFLOW ----'].join('\n'));
  parts.push(configSection(host, cfg, theEnv));
  parts.push(environmentSection(cfg, theEnv, runDir || peek.dir, peek.root));
  parts.push(layoutSection(host, cfg));
  parts.push(targetSection(target));
  if (headless) parts.push(headlessSection());
  parts.push('Begin with Step 0: check for a resumable run, then create the task list.');

  return `${parts.join('\n\n')}\n`;
}

// --------------------------------------------------------------- command

async function run(args) {
  const host = findHost(args);
  const cfg = readConfig(host, { required: true });

  const target = resolveTarget(args._);
  if (!target) {
    fail('no target. Pass a ticket id (ABC-123), "all", or "fix <RUN-ID>".');
    return;
  }
  if (target.mode === 'fix' && !target.id) {
    fail('"fix" needs a run id, for example `qc-check prompt fix ABC-123`.');
    return;
  }

  const headless = args.headless === true || args.headless === 'true' || Boolean(cfg.agent && cfg.agent.headless);
  const env = resolveEnv(cfg, args.env);
  guardProtected(cfg, env, args);
  const text = buildPrompt({ host, cfg, target, headless, env });

  if (args.out && args.out !== true) {
    const out = path.resolve(String(args.out));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, text);
    info(`prompt written to ${out} (${text.split('\n').length} lines)`);
    return;
  }

  process.stdout.write(text);
}

function help() {
  info(`qc-check prompt - print the QC prompt instead of running it.

Usage
  qc-check prompt <target> [options]

Targets
  ABC-123            QC one ticket
  all | full | sweep QC every screen, no ticket
  fix <RUN-ID>       fix what a previous run found

Options
  --dir <path>    use this repository instead of the current one
  --env <name>    the environment the prompt targets
  --allow-protected  required for a protected environment such as prod
  --headless      include the eval-mode rules (no questions, no publishing)
  --out <file>    write the prompt to a file instead of stdout

The prompt is self-contained: the whole workflow, the resolved configuration
with nothing credential-shaped in it, and the absolute paths of the runtime
scripts and the phase references. Hand it to any agent that has a shell and
can read files.

Examples
  qc-check prompt ABC-123
  qc-check prompt ABC-123 | pbcopy
  qc-check prompt all --out /tmp/qc-sweep.txt`);
}

module.exports = { run, help, buildPrompt, resolveTarget };
