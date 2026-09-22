'use strict';

// qc-check run <target>
//
// Assembles the QC prompt (cli/prompt.js owns the assembly) and hands it to
// the configured agent. The CLI does no QC of its own: it checks that a run
// can succeed, launches the agent, and says where the evidence landed.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const {
  RUNTIME_DIR,
  CONFIG_FILE,
  info,
  fail,
  heading,
  findHost,
  readConfig,
  reportsDirOf,
  credentialsPathOf,
  which,
  tryExec,
  appiumReachable,
} = require('./util');
const { resolveEnv, guardProtected, runKey, peekRun, hostRuntime, isProtected } = require('./envs');

const { buildPrompt, resolveTarget } = require('./prompt');

const KINDS = ['claude', 'codex', 'custom', 'none'];

// ------------------------------------------------------------------ target

// With no argument the branch name is the next best source of a ticket id,
// validated against the same pattern the runtime uses.
function ticketFromBranch(host, cfg) {
  const pattern = (cfg.tracker && cfg.tracker.ticketPattern) || '[A-Z]+-[0-9]+';
  const res = tryExec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: host });
  if (!res.ok || !res.stdout) return null;
  let re;
  try {
    re = new RegExp(pattern, 'i');
  } catch (_) {
    return null;
  }
  const m = res.stdout.match(re);
  return m ? m[0].toUpperCase() : null;
}

function validTicket(cfg, id) {
  const pattern = (cfg.tracker && cfg.tracker.ticketPattern) || '[A-Z]+-[0-9]+';
  try {
    return new RegExp(`^(?:${pattern})$`).test(id);
  } catch (_) {
    return true; // a broken pattern must not block a run
  }
}

// ---------------------------------------------------------------- preflight

function ok(label, detail) {
  info(`  ok    ${label}${detail ? `: ${detail}` : ''}`);
}

function bad(problems, label, fixText) {
  info(`  FIX   ${label}`);
  info(`        ${fixText}`);
  problems.push(label);
}

function needsLogin(cfg) {
  // Any enabled profile drives the app, and every app pass logs in.
  const devices = cfg.devices || {};
  return ['android', 'android_tablet', 'ios'].some((n) => devices[n] && devices[n].enabled === true);
}

function preflight(host, cfg, env) {
  const problems = [];
  heading('Preflight');

  ok(CONFIG_FILE, path.join(host, CONFIG_FILE));

  const runtime = path.join(host, RUNTIME_DIR);
  if (fs.existsSync(path.join(runtime, 'driver.js'))) ok('runtime', runtime);
  else bad(problems, `runtime missing at ${runtime}`, 'run `qc-check setup` to install it');

  const profiles = ['android', 'android_tablet', 'ios'].filter(
    (n) => cfg.devices && cfg.devices[n] && cfg.devices[n].enabled === true,
  );
  if (profiles.length > 0) ok('device profiles enabled', profiles.join(', '));
  else {
    bad(
      problems,
      'no device profile is enabled',
      `set devices.android.enabled to true in ${CONFIG_FILE}, or run \`qc-check setup\``,
    );
  }

  if (needsLogin(cfg)) {
    // Presence only, per environment. The values are the runtime's business.
    let status = null;
    try {
      if (!fs.existsSync(path.join(host, RUNTIME_DIR, 'runs.js'))) throw new Error('old runtime');
      const { config } = hostRuntime(host, env);
      status = config.credentialStatus(env);
    } catch (_) {
      status = fs.existsSync(credentialsPathOf(host, cfg)) ? 'file' : 'missing';
    }
    if (status === 'file' || status === 'env') {
      ok(`credentials for ${env}`, status === 'env' ? 'from QC_CRED_* variables' : 'from the credentials file');
    } else {
      const key = String(env).toUpperCase().replace(/[^A-Z0-9]/g, '_');
      bad(
        problems,
        `no usable credentials for ${env} (${status})`,
        `run \`qc-check env credentials ${env}\`, or export QC_CRED_${key}_USERNAME and QC_CRED_${key}_PASSWORD`,
      );
    }
  }

  const appium = (cfg.devices && cfg.devices.appium) || {};
  const aHost = appium.host || '127.0.0.1';
  const aPort = appium.port || 4723;
  if (appiumReachable(aHost, aPort)) ok('appium', `http://${aHost}:${aPort}`);
  else {
    bad(
      problems,
      `appium is not answering on ${aHost}:${aPort}`,
      `start it with \`appium --address ${aHost} --port ${aPort}\` (install: npm i -g appium && appium driver install uiautomator2)`,
    );
  }

  return problems;
}

// ------------------------------------------------------------------- agent

// Split a command string on whitespace, honouring single and double quotes so
// a configured command can carry an argument with a space in it.
function tokenize(cmd) {
  const out = [];
  let cur = '';
  let quote = null;
  let started = false;
  for (const ch of String(cmd)) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started || cur) out.push(cur);
      cur = '';
      started = false;
      continue;
    }
    cur += ch;
    started = true;
  }
  if (started || cur) out.push(cur);
  return out;
}

const PROMPT_TOKEN = '{prompt}';

// What to execute for this agent kind. stdinPrompt means the prompt is not on
// the command line and must be written to the child's stdin instead.
function agentCommand(kind, cfg, prompt, headless) {
  const extra = ((cfg.agent && cfg.agent.extraArgs) || []).map(String);

  if (kind === 'claude') {
    // -p is the headless form; interactive gets the prompt as the opening
    // message so the user can watch and answer the approval gate.
    const argv = headless ? ['-p', prompt] : [prompt];
    return { cmd: 'claude', argv: argv.concat(extra), stdinPrompt: false, promptIndex: headless ? 1 : 0 };
  }

  if (kind === 'codex') {
    const argv = headless ? ['exec', prompt] : [prompt];
    return { cmd: 'codex', argv: argv.concat(extra), stdinPrompt: false, promptIndex: headless ? 1 : 0 };
  }

  if (kind === 'custom') {
    const raw = (cfg.agent && cfg.agent.command) || '';
    if (!raw.trim()) {
      fail(`agent.kind is "custom" but agent.command is empty in ${CONFIG_FILE}.`);
    }
    const tokens = tokenize(raw);
    const cmd = tokens[0];
    let promptIndex = -1;
    const argv = tokens.slice(1).map((t, i) => {
      if (!t.includes(PROMPT_TOKEN)) return t;
      promptIndex = i;
      return t.split(PROMPT_TOKEN).join(prompt);
    });
    const usesPlaceholder = promptIndex >= 0 || tokens[0].includes(PROMPT_TOKEN);
    return {
      cmd,
      argv: argv.concat(extra),
      stdinPrompt: !usesPlaceholder,
      promptIndex,
    };
  }

  return null; // kind none: nothing is executed
}

// The command as a readable line, with the prompt reduced to its size so a
// dry run stays legible.
function describe(spec, prompt) {
  const stand = `<prompt: ${prompt.split('\n').length} lines, ${prompt.length} chars>`;
  const shown = spec.argv.map((a, i) => (i === spec.promptIndex || a === prompt ? stand : quoteIfNeeded(a)));
  return `${spec.cmd} ${shown.join(' ')}`.trim();
}

function quoteIfNeeded(s) {
  return /\s/.test(s) ? `"${s}"` : s;
}

// ------------------------------------------------------------------ launch

function launch(spec, { host, prompt, timeoutMinutes, childEnv }) {
  return new Promise((resolve) => {
    const child = spawn(spec.cmd, spec.argv, {
      cwd: host,
      stdio: spec.stdinPrompt ? ['pipe', 'inherit', 'inherit'] : 'inherit',
      env: childEnv || process.env,
    });

    if (spec.stdinPrompt) {
      child.stdin.on('error', () => {}); // the agent may not read stdin at all
      child.stdin.write(prompt);
      child.stdin.end();
    }

    let timedOut = false;
    const ms = Math.max(1, Number(timeoutMinutes) || 180) * 60 * 1000;
    const timer = setTimeout(() => {
      timedOut = true;
      info('');
      info(`qc-check: the agent hit the ${timeoutMinutes} minute limit (agent.timeoutMinutes). Stopping it.`);
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, ms);

    // Ctrl-C must reach the agent, not just this wrapper: the run is on disk
    // and picks up where it stopped.
    const onSigint = () => {
      info('');
      info('qc-check: stopping the agent. State is on disk, so the run is resumable.');
      child.kill('SIGINT');
    };
    process.on('SIGINT', onSigint);

    child.on('error', (err) => {
      clearTimeout(timer);
      process.removeListener('SIGINT', onSigint);
      resolve({ code: 127, error: err, timedOut });
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      process.removeListener('SIGINT', onSigint);
      resolve({ code: code === null ? (signal ? 130 : 1) : code, timedOut });
    });
  });
}

// ------------------------------------------------------------------- after

function evidence(host, cfg, target, env, run, runs) {
  heading('Evidence');
  let summary = null;
  if (run && runs) {
    try {
      summary = runs.writeSummary(run);
      runs.rebuildIndex();
    } catch (_) {
      /* the listing below still helps */
    }
  }
  info(`  environment  ${env}`);
  info(`  run folder   ${run ? run.dir : '(not opened)'}`);
  if (summary) {
    info(`  verdict      ${summary.verdict || 'no report yet'}`);
    info(`  findings     ${summary.findings.red} red, ${summary.findings.yellow} yellow`);
    info(`  evidence     ${summary.artifacts.screenshots} screenshots, ${summary.artifacts.recordings} recordings, ${summary.artifacts.api} api captures`);
  }
  info(`  index        ${path.join(reportsDirOf(host, cfg), 'index.md')}`);
  info('');
  const arg = target.mode === 'fix' ? `fix ${target.id}` : target.mode === 'sweep' ? 'all' : target.id;
  info(`  qc-check status ${arg} --env ${env}      where the run got to`);
  info(`  qc-check report ${arg} --env ${env}      the report itself`);
}

// ----------------------------------------------------------------- command

async function run(args) {
  const host = findHost(args);
  const cfg = readConfig(host, { required: true });

  let target = resolveTarget(args._);
  if (!target) {
    const derived = ticketFromBranch(host, cfg);
    if (!derived) {
      fail(
        'no target, and no ticket id could be read from the branch name.\n' +
          '  Pass one: `qc-check run ABC-123`, `qc-check run all`, or `qc-check run fix ABC-123`.',
      );
      return;
    }
    target = { mode: 'ticket', id: derived, label: derived };
    info(`qc-check: no target given, using ${derived} from the current branch.`);
  }
  if (target.mode === 'fix' && !target.id) {
    fail('"fix" needs a run id, for example `qc-check run fix ABC-123`.');
    return;
  }
  if (target.mode === 'ticket' && !validTicket(cfg, target.id)) {
    fail(
      `"${target.id}" does not match tracker.ticketPattern ` +
        `(${(cfg.tracker && cfg.tracker.ticketPattern) || '[A-Z]+-[0-9]+'}) in ${CONFIG_FILE}.`,
    );
    return;
  }

  const agentCfg = cfg.agent || {};
  const kind = String(args.agent && args.agent !== true ? args.agent : agentCfg.kind || 'claude');
  if (!KINDS.includes(kind)) {
    fail(`unknown agent kind "${kind}". Use one of: ${KINDS.join(', ')}.`);
    return;
  }

  const headless = args.headless === true || args.headless === 'true' || Boolean(agentCfg.headless);
  const dryRun = args['dry-run'] === true || args['dry-run'] === 'true';
  const env = resolveEnv(cfg, args.env);
  guardProtected(cfg, env, args);
  const key = runKey(target);
  const peek = peekRun(host, cfg, key, env);
  let prompt = buildPrompt({ host, cfg, target, headless, env, runDir: peek.dir });

  // kind none never launches anything: the prompt is the deliverable.
  if (kind === 'none') {
    if (dryRun) {
      heading('Dry run (agent kind: none)');
      info(`  target      ${target.label}`);
      info(`  environment ${env}${isProtected(cfg, env) ? ' (protected, allowed)' : ''}`);
      info(`  run folder  ${peek.dir ? `resumes ${peek.dir}` : `new, under ${peek.root}`}`);
      info(`  headless    ${headless ? 'yes' : 'no'}`);
      info(`  cwd         ${host}`);
      info('');
      info(`  nothing is executed: the prompt (${prompt.split('\n').length} lines) is printed for you to paste`);
      return;
    }
    process.stdout.write(prompt);
    info('');
    info('qc-check: agent.kind is "none", so nothing was run. The prompt above is');
    info('ready to paste into any agent that has a shell and can read files.');
    return;
  }

  const spec = agentCommand(kind, cfg, prompt, headless);
  if (!spec) return;

  if (dryRun) {
    heading(`Dry run (agent kind: ${kind})`);
    info(`  target      ${target.label}`);
    info(`  environment ${env}${isProtected(cfg, env) ? ' (protected, allowed)' : ''}`);
    info(`  run folder  ${peek.dir ? `resumes ${peek.dir}` : `new, under ${peek.root}`}`);
    info(`  headless    ${headless ? 'yes' : 'no'}`);
    info(`  cwd         ${host}`);
    info(`  timeout     ${agentCfg.timeoutMinutes || 180} min`);
    info(`  stdin       ${spec.stdinPrompt ? 'the prompt is written to the agent stdin' : 'not used'}`);
    info('');
    info(`  ${describe(spec, prompt)}`);
    return;
  }

  const problems = preflight(host, cfg, env);
  if (problems.length > 0) {
    info('');
    fail(`${problems.length} ${problems.length === 1 ? 'thing' : 'things'} to fix before a run can succeed. See FIX above.`);
    return;
  }

  if (!which(spec.cmd)) {
    fail(
      `the agent binary "${spec.cmd}" is not on PATH.\n` +
        `  Install it, or set agent.kind to "none" in ${CONFIG_FILE} and use\n` +
        '  `qc-check prompt ' +
        (target.mode === 'sweep' ? 'all' : target.id) +
        '` to drive any agent by hand.',
    );
    return;
  }

  // Open (or resume) the run folder now, so the agent is told exactly where its
  // evidence goes and every script it calls agrees.
  const { runs } = hostRuntime(host, env);
  const theRun = runs.openRun({ ticket: key, env });
  prompt = buildPrompt({ host, cfg, target, headless, env, runDir: theRun.dir });
  const childEnv = { ...process.env, QC_ENV: env, QC_RUN_DIR: theRun.dir };
  if (headless) childEnv.QC_EVAL = '1';

  heading(`Running QC: ${target.label} on ${env}`);
  info(`  run      ${theRun.created ? 'new' : 'resuming'} ${theRun.dir}`);
  info(`  agent    ${kind} (${spec.cmd})`);
  info(`  mode     ${headless ? 'headless: plan auto-approved, no commits, no publishing' : 'interactive: you approve the test plan'}`);
  info(`  timeout  ${agentCfg.timeoutMinutes || 180} min`);
  info('');

  const result = await launch(spec, {
    host,
    prompt,
    timeoutMinutes: agentCfg.timeoutMinutes || 180,
    childEnv,
  });

  if (result.error) {
    fail(`could not start "${spec.cmd}": ${result.error.message}`);
    return;
  }

  evidence(host, cfg, target, env, theRun, runs);

  if (result.timedOut) {
    info('');
    const arg = target.mode === 'fix' ? `fix ${target.id}` : target.mode === 'sweep' ? 'all' : target.id;
    info(`qc-check: timed out. Resume with \`qc-check run ${arg} --env ${env}\`: the run continues from disk.`);
    process.exitCode = result.code || 124;
    return;
  }

  process.exitCode = result.code;
}

function help() {
  info(`qc-check run - run a QC pass and hand it to your agent.

Usage
  qc-check run [target] [options]

Targets
  ABC-123            QC one ticket
  all | full | sweep QC every screen, no ticket
  fix <RUN-ID>       fix what a previous run found
  (none)             derive the ticket id from the current branch name

Options
  --dir <path>      use this repository instead of the current one
  --env <name>      the environment to test; build, backend and account follow it
  --allow-protected required to target a protected environment such as prod
  --headless        no questions: auto-approve the plan, no commits, no publishing
  --agent <kind>    override agent.kind for this run: claude, codex, custom, none
  --dry-run         print exactly what would be executed, and run nothing

What happens
  1. A short preflight: config, runtime, credentials for the environment, Appium, devices.
  2. The prompt is assembled, exactly as \`qc-check prompt\` prints it.
  3. Your agent is launched with it, attached to this terminal so you can
     watch it and answer the test-plan approval gate.

Ctrl-C stops the agent. Nothing is lost: the run state lives in the reports
directory, so \`qc-check run <same target>\` picks up where it stopped.

Examples
  qc-check run ABC-123
  qc-check run all --headless
  qc-check run fix ABC-123 --agent codex
  qc-check run ABC-123 --dry-run`);
}

module.exports = { run, help };
