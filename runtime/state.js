#!/usr/bin/env node
// QC - resumable per-ticket run state. Lets a crashed or interrupted QC run
// resume where it left off (smoke already green, phone pass done -> start at
// unit-tests) instead of redoing everything.
//
// State lives in <run dir>/state.json, where the run dir is
// <reportsDir>/<TICKET>/<env>/<run-id>/ (see runs.js). The environment comes
// from QC_ENV (or backend.defaultEnv), so the same ticket tested on two
// environments keeps two separate histories.
//
// Usage:
//   node runtime/state.js <TICKET> get [--json]
//   node runtime/state.js <TICKET> set <phase> <status> [note...]
//   node runtime/state.js <TICKET> step <phase> <sub-step> <status> [note...]
//   node runtime/state.js <TICKET> plan <phase> <step1,step2,...>
//   node runtime/state.js <TICKET> finding <red|yellow> <text...>
//   node runtime/state.js <TICKET> reset      # start a fresh run; the old one is kept
//
// Everything a resumed run needs lives on disk: this state file (phases,
// sub-steps, notes, findings), the approved plan <run dir>/plan.md, and the
// evidence files in the run dir. A re-run after ANY interruption resumes from
// here - it never starts from scratch.
//
// Canonical phases: ticket, test-plan, contract, smoke, phone, tablet, ios, unit-tests, report, publish
// Statuses: pending | in_progress | pass | fail | blocked | skipped
//
// Sub-steps: each phase has default sub-steps (seeded when the phase first goes
// in_progress). `plan` replaces the list (device phases: one case-N per test
// case), `step` records a transition - unknown step names are appended. `get`
// renders per-phase progress ([k/N] + per-step icons) and the exact
// phase/sub-step to resume at.
//
// Gate: no phase after test-plan can go in_progress/pass until test-plan is
// pass (the user approved the DoD + test cases in <run dir>/plan.md) or
// skipped (legacy runs started before this phase existed).
'use strict';

const fs = require('fs');
const path = require('path');

const PHASES = ['ticket', 'test-plan', 'contract', 'smoke', 'phone', 'tablet', 'ios', 'unit-tests', 'report', 'publish'];
const STATUSES = ['pending', 'in_progress', 'pass', 'fail', 'blocked', 'skipped'];
// pass/blocked/skipped = resolved; pending/in_progress/fail = still needs work (resume here)
const UNRESOLVED = ['pending', 'in_progress', 'fail'];

const DEVICE_STEPS = ['preflight', 'connect', 'login', 'record', 'cases', 'teardown'];
const DEFAULT_STEPS = {
  ticket: ['derive-id', 'fetch-ticket', 'read-code'],
  'test-plan': ['dod', 'test-cases', 'write-md', 'approval'],
  contract: ['identify-write', 'be-ref', 'live-check', 'verdict'],
  smoke: ['health', 'auth', 'roundtrip', 'verdict'],
  phone: DEVICE_STEPS,
  tablet: DEVICE_STEPS,
  ios: DEVICE_STEPS,
  'unit-tests': ['identify-units', 'extend-suites', 'run-green', 'commit'],
  report: ['assemble'],
  publish: ['comment', 'attachments', 'labels', 'confirm'],
};

// ASCII only: CI logs and Windows terminals mangle box-drawing glyphs and emoji.
// All markers are the same width so the columns in render() line up.
const ICONS = { pass: '[x]', fail: '[!]', blocked: '[!]', skipped: '[-]', in_progress: '[>]', pending: '[ ]' };

const USAGE = 'usage: state.js <TICKET> get [--json] | set <phase> <status> [note] | step <phase> <sub-step> <status> [note] | plan <phase> <s1,s2,...> | finding <red|yellow> <text> | reset';

const [ticketArg, cmd, ...rest] = process.argv.slice(2);

function usage(stream = console.error, code = 1) {
  stream(USAGE);
  process.exit(code);
}

// --help must work before any config is loaded.
if (ticketArg === '--help' || ticketArg === '-h' || cmd === '--help') {
  console.log(USAGE);
  console.log('');
  console.log(`phases:   ${PHASES.join(', ')}`);
  console.log(`statuses: ${STATUSES.join(', ')}`);
  console.log('State file: <project.reportsDir>/<TICKET>/<env>/<run-id>/state.json (env: QC_ENV or backend.defaultEnv).');
  process.exit(0);
}
if (!ticketArg || !cmd) {
  usage();
}

const config = require('./config.js');
const runs = require('./runs.js');

const ticket = ticketArg.toUpperCase();
if (!config.validateTicket(ticket)) {
  console.error(`"${ticketArg}" is not a valid ticket id for this repo - see tracker.ticketPattern in qc.config.json (e.g. ABC-123)`);
  process.exit(1);
}

const env = config.activeEnv();

// `qc-check run` hands the agent QC_RUN_DIR; when it names this ticket and
// environment it is the run to write to, even if `current` moved meanwhile.
function resolveRun() {
  const fromEnv = process.env.QC_RUN_DIR ? runs.currentRun() : null;
  if (fromEnv && fromEnv.ticket === ticket && fromEnv.env === env) {return fromEnv;}
  return runs.openRun({ ticket, env });
}

let run = resolveRun();
let file = path.join(run.dir, 'state.json');
// Paths in messages are relative to the cwd so a human can paste them straight back.
const rel = p => path.relative(process.cwd(), p) || '.';

function load() {
  if (!fs.existsSync(file)) {return null;}
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function fresh() {
  return { ticket, env, runId: run.id, createdAt: new Date().toISOString(), phases: {} };
}

// summary.json and the index must never lag the state they describe.
function publish() {
  try {
    runs.writeSummary(run);
    runs.rebuildIndex();
  } catch (err) {
    console.error(`WARN: summary/index not updated: ${err.message}`);
  }
}

function save(state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
  publish();
}

function requirePhase(phase) {
  if (!PHASES.includes(phase)) {
    console.error(`unknown phase "${phase}" - one of: ${PHASES.join(', ')}`);
    process.exit(1);
  }
}

function requireStatus(status) {
  if (!STATUSES.includes(status)) {
    console.error(`unknown status "${status}" - one of: ${STATUSES.join(', ')}`);
    process.exit(1);
  }
}

// HARD GATE: work past test-plan only starts once the user approved the plan.
function requirePlanApproved(state, phase, status) {
  if (PHASES.indexOf(phase) <= PHASES.indexOf('test-plan')) {return;}
  if (!['in_progress', 'pass'].includes(status)) {return;}
  const tp = state.phases['test-plan'];
  if (tp && ['pass', 'skipped'].includes(tp.status)) {return;}
  console.error(
    `BLOCKED: test-plan is ${tp ? tp.status : 'missing'} - the user has not approved the DoD + test cases yet.\n` +
    `   Write ${rel(path.join(run.dir, 'plan.md'))}, get approval, then: state.js ${ticket} set test-plan pass\n` +
    `   (run predating the test-plan phase: state.js ${ticket} set test-plan skipped legacy run)`
  );
  process.exit(1);
}

function seedSteps(state, phase) {
  const entry = state.phases[phase] || (state.phases[phase] = {});
  if (!entry.steps) {
    entry.steps = {};
    for (const s of DEFAULT_STEPS[phase] || []) {entry.steps[s] = { status: 'pending' };}
  }
  return entry;
}

function stepProgress(steps) {
  const names = Object.keys(steps);
  const done = names.filter(s => !UNRESOLVED.includes(steps[s].status)).length;
  return { done, total: names.length };
}

function firstUnresolvedStep(steps) {
  return Object.keys(steps).find(s => UNRESOLVED.includes(steps[s].status));
}

function resumePoint(state) {
  const phase = PHASES.find(p => !state.phases[p] || UNRESOLVED.includes(state.phases[p].status));
  if (!phase) {return null;}
  const steps = state.phases[phase] && state.phases[phase].steps;
  const step = steps ? firstUnresolvedStep(steps) : null;
  return step ? `${phase}/${step}` : phase;
}

function header() {
  console.log(`  run: ${rel(run.dir)}`);
  console.log(`  env: ${env}${config.isProtectedEnv(env) ? ' (protected)' : ''}`);
}

function render(state) {
  console.log(`${state.ticket} - QC run state`);
  header();
  for (const p of PHASES) {
    const entry = state.phases[p];
    const status = entry ? entry.status || 'pending' : 'pending';
    const icon = ICONS[status] || ICONS.pending;
    let line = `  ${icon} ${p.padEnd(11)} ${status.padEnd(12)}`;
    if (entry && entry.steps && Object.keys(entry.steps).length) {
      const { done, total } = stepProgress(entry.steps);
      line += `[${done}/${total}]`;
    }
    if (entry && entry.note) {line += `  - ${entry.note}`;}
    console.log(line);
    // step detail only where it matters: the phase still being worked (or failed)
    if (entry && entry.steps && UNRESOLVED.includes(status) && Object.keys(entry.steps).length) {
      const detail = Object.entries(entry.steps)
        .map(([name, s]) => {
          const noteworthy = (s.status === 'fail' || s.status === 'blocked') && s.note;
          return `${ICONS[s.status] || ICONS.pending}${name}${noteworthy ? `(${s.note})` : ''}`;
        })
        .join('  ');
      console.log(`      ${detail}`);
    }
  }
  if (state.findings && state.findings.length) {
    console.log(`\nFindings (${state.findings.length}):`);
    for (const f of state.findings) {console.log(`  ${f.severity === 'red' ? 'RED:   ' : 'YELLOW:'} ${f.text}`);}
  }
  const next = resumePoint(state);
  console.log(`\n-> resume at: ${next || 'done (all phases resolved)'}`);
}

switch (cmd) {
  case 'get': {
    const state = load();
    if (!state) {
      console.log(`(no state for ${ticket} - fresh run)`);
      header();
      process.exit(0);
    }
    if (rest.includes('--json')) {
      console.log(JSON.stringify(state, null, 2));
      const next = resumePoint(state);
      console.log(`\n-> resume at: ${next || 'done (all phases resolved)'}`);
    } else {
      render(state);
    }
    break;
  }
  case 'set': {
    const [phase, status] = rest;
    const note = rest.slice(2).join(' ');
    requirePhase(phase);
    requireStatus(status);
    const state = load() || fresh();
    requirePlanApproved(state, phase, status);
    const prev = state.phases[phase] || {};
    state.phases[phase] = { ...prev, status, updatedAt: new Date().toISOString(), ...(note ? { note } : {}) };
    // starting a phase seeds its default sub-steps so progress is visible from step one
    if (status === 'in_progress') {seedSteps(state, phase);}
    save(state);
    // auto-record token/cost usage at every phase transition (cost.js); a cost
    // failure must never block the state transition itself
    try {
      require('child_process').execFileSync(
        process.execPath,
        [path.join(__dirname, 'cost.js'), ticket, 'snapshot', `${phase}:${status}`],
        // Pin the child to this run so the cost lands next to this state.
        { stdio: 'ignore', env: { ...process.env, QC_RUN_DIR: run.dir, QC_ENV: env } }
      );
    } catch { /* cost tracking is best-effort */ }
    const steps = state.phases[phase].steps;
    const prog = steps && Object.keys(steps).length ? ` [${stepProgress(steps).done}/${Object.keys(steps).length}]` : '';
    console.log(`${ticket} ${phase} -> ${status}${prog}${note ? ` (${note})` : ''}`);
    break;
  }
  case 'step': {
    const [phase, step, status] = rest;
    const note = rest.slice(3).join(' ');
    if (!phase || !step || !status) {usage();}
    requirePhase(phase);
    requireStatus(status);
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(step)) {
      console.error(`bad sub-step name "${step}" - lowercase kebab-case (e.g. case-3, login)`);
      process.exit(1);
    }
    const state = load() || fresh();
    requirePlanApproved(state, phase, 'in_progress');
    const entry = seedSteps(state, phase);
    // working a sub-step means the phase itself is underway
    if (!entry.status || entry.status === 'pending') {entry.status = 'in_progress';}
    entry.steps[step] = { status, updatedAt: new Date().toISOString(), ...(note ? { note } : {}) };
    entry.updatedAt = new Date().toISOString();
    save(state);
    const { done, total } = stepProgress(entry.steps);
    console.log(`${ticket} ${phase}/${step} -> ${status} [${done}/${total}]${note ? ` (${note})` : ''}`);
    break;
  }
  case 'plan': {
    const [phase, list] = rest;
    if (!phase || !list) {usage();}
    requirePhase(phase);
    const names = list.split(',').map(s => s.trim()).filter(Boolean);
    if (!names.length) {usage();}
    for (const n of names) {
      if (!/^[a-z0-9][a-z0-9._-]*$/.test(n)) {
        console.error(`bad sub-step name "${n}" - lowercase kebab-case (e.g. case-3, login)`);
        process.exit(1);
      }
    }
    const state = load() || fresh();
    const entry = state.phases[phase] || (state.phases[phase] = { status: 'pending' });
    const prev = entry.steps || {};
    entry.steps = {};
    for (const n of names) {entry.steps[n] = prev[n] || { status: 'pending' };}
    save(state);
    console.log(`${ticket} ${phase} sub-steps -> ${names.join(', ')}`);
    break;
  }
  case 'finding': {
    const [severity] = rest;
    const text = rest.slice(1).join(' ');
    if (!['red', 'yellow'].includes(severity) || !text) {
      console.error('usage: state.js <TICKET> finding <red|yellow> <text>  (red = backend/product | yellow = quality/tooling)');
      process.exit(1);
    }
    const state = load() || fresh();
    state.findings = state.findings || [];
    state.findings.push({ severity, text, at: new Date().toISOString() });
    save(state);
    console.log(`${ticket} finding[${state.findings.length}] ${severity === 'red' ? 'RED:' : 'YELLOW:'} ${text}`);
    break;
  }
  case 'reset': {
    // Nothing is deleted: a reset opens a new run folder and points `current`
    // at it, so the evidence of the previous attempt stays on disk.
    const prev = run;
    // A run this very call created is already fresh; reuse it.
    if (!prev.created) {
      // Run ids are UTC seconds; wait out the second the previous run was
      // opened in, or openRun would hand back the same folder.
      const sameSecond = () => fs.existsSync(path.join(path.dirname(prev.dir), runs.newRunId()));
      const until = Date.now() + 1500;
      while (sameSecond() && Date.now() < until) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
      run = runs.openRun({ ticket, env, fresh: true });
      file = path.join(run.dir, 'state.json');
    }
    publish();
    console.log(`state for ${ticket} cleared`);
    console.log(`  run: ${rel(run.dir)} (new)`);
    if (prev.dir !== run.dir) {console.log(`  previous run kept: ${rel(prev.dir)}`);}
    console.log(`  env: ${env}`);
    break;
  }
  default:
    usage();
}
