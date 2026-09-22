#!/usr/bin/env node
'use strict';

// Where a QC run keeps its evidence.
//
//   <reportsDir>/
//     index.md, index.json          every run, newest first
//     .active.json                  the run in progress (never committed)
//     <TICKET>/<env>/
//       current                     id of the run a re-run resumes
//       <run-id>/
//         summary.json              verdict, phases, findings, artifact counts
//         report.md  plan.md  state.json  cost.json  cost.md
//         screenshots/  recordings/  trees/  api/
//
// One folder per run means evidence from two tickets, or from the same ticket
// on two environments, can never mix, and an old run is never overwritten by
// a new one.
//
//   node qc/runs.js --help

const fs = require('fs');
const path = require('path');

const config = require('./config.js');

const KINDS = ['screenshots', 'recordings', 'trees', 'api'];
const ACTIVE_FILE = '.active.json';

// A run id is a UTC timestamp, so folders sort chronologically by name.
function newRunId(now = new Date()) {
  return now.toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');
}

function safe(segment) {
  return String(segment).replace(/[^A-Za-z0-9._-]/g, '_');
}

function ticketRoot(ticket, env) {
  return path.join(config.reportsDir(), safe(ticket), safe(env));
}

function runInfo(ticket, env, id) {
  const dir = path.join(ticketRoot(ticket, env), id);
  const sub = {};
  for (const k of KINDS) sub[k] = path.join(dir, k);
  return { ticket, env, id, dir, sub };
}

function ensureDirs(run) {
  fs.mkdirSync(run.dir, { recursive: true });
  for (const k of KINDS) fs.mkdirSync(run.sub[k], { recursive: true });
}

function writeActive(run) {
  const file = path.join(config.reportsDir(), ACTIVE_FILE);
  fs.writeFileSync(
    file,
    `${JSON.stringify({ ticket: run.ticket, env: run.env, id: run.id, dir: run.dir }, null, 2)}\n`,
  );
}

// The run for a ticket on an environment. Resumes the current one unless
// `fresh` is set or there is none yet, in which case a new folder is made.
function openRun({ ticket, env = config.activeEnv(), fresh = false } = {}) {
  if (!ticket) throw new Error('openRun needs a ticket');
  const root = ticketRoot(ticket, env);
  const pointer = path.join(root, 'current');

  let id = null;
  if (!fresh && fs.existsSync(pointer)) {
    const candidate = fs.readFileSync(pointer, 'utf8').trim();
    if (candidate && fs.existsSync(path.join(root, candidate))) id = candidate;
  }
  const created = !id;
  if (!id) id = newRunId();

  const run = runInfo(ticket, env, id);
  ensureDirs(run);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(pointer, `${id}\n`);
  writeActive(run);
  return { ...run, created };
}

// The run in progress, for scripts that are not told which ticket they serve
// (screenshots, recordings, tree dumps). QC_RUN_DIR wins; it is set by
// `qc-check run` for the agent it launches.
function currentRun() {
  const fromEnv = process.env.QC_RUN_DIR;
  if (fromEnv && fs.existsSync(fromEnv)) {
    const id = path.basename(fromEnv);
    const env = path.basename(path.dirname(fromEnv));
    const ticket = path.basename(path.dirname(path.dirname(fromEnv)));
    const run = runInfo(ticket, env, id);
    ensureDirs(run);
    return run;
  }
  const file = path.join(config.reportsDir(), ACTIVE_FILE);
  if (!fs.existsSync(file)) return null;
  try {
    const a = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!a.dir || !fs.existsSync(a.dir)) return null;
    const run = runInfo(a.ticket, a.env, a.id);
    ensureDirs(run);
    return run;
  } catch (_) {
    return null;
  }
}

// Next path for an artifact, numbered in capture order: 001-login.png.
// With no run in progress it lands in _unsorted/ and says so, rather than
// silently mixing into another run's evidence.
function artifactPath(kind, name, ext) {
  if (!KINDS.includes(kind)) throw new Error(`unknown artifact kind "${kind}"`);
  const slug = String(name || kind).replace(/\s+/g, '-').replace(/[^A-Za-z0-9._-]/g, '') || kind;
  const run = currentRun();

  if (!run) {
    const dir = path.join(config.reportsDir(), '_unsorted');
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    process.stderr.write(
      'WARN: no QC run in progress, so this is saved under _unsorted/. ' +
        'Start one with `qc-check run <ticket>` or `node qc/state.js <ticket> set ticket in_progress`.\n',
    );
    return path.join(dir, `${slug}-${ts}.${ext}`);
  }

  const dir = run.sub[kind];
  const taken = fs.readdirSync(dir).filter(f => /^\d{3}-/.test(f)).length;
  return path.join(dir, `${String(taken + 1).padStart(3, '0')}-${slug}.${ext}`);
}

// ------------------------------------------------------------------ summary

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function verdictOf(reportFile) {
  if (!fs.existsSync(reportFile)) return null;
  const m = fs.readFileSync(reportFile, 'utf8').match(/^##\s*Overall:\s*\**\s*(PASS|FAIL|BLOCKED)/im);
  return m ? m[1].toUpperCase() : null;
}

function countFiles(dir) {
  try {
    return fs.readdirSync(dir).filter(f => !f.startsWith('.')).length;
  } catch (_) {
    return 0;
  }
}

// Machine-readable account of one run, rewritten whenever state changes, so a
// CI job or a dashboard can read the outcome without parsing markdown.
function writeSummary(run) {
  const state = readJson(path.join(run.dir, 'state.json')) || {};
  const cost = readJson(path.join(run.dir, 'cost.json'));
  const phases = {};
  for (const [name, p] of Object.entries(state.phases || {})) phases[name] = (p && p.status) || 'pending';
  const findings = state.findings || [];
  const red = findings.filter(f => String(f.severity || f.level).toLowerCase() === 'red').length;
  const yellow = findings.filter(f => String(f.severity || f.level).toLowerCase() === 'yellow').length;

  let app = {};
  let backendUrl = '';
  try {
    const cfg = config.loadConfig();
    const flavor = (cfg.app.flavors || {})[run.env] || (cfg.app.flavors || {})[cfg.app.defaultFlavor] || {};
    app = { androidPackage: flavor.androidPackage || '', iosBundleId: flavor.iosBundleId || '' };
    backendUrl = (cfg.backend.baseUrls || {})[run.env] || '';
  } catch (_) {
    /* summary still useful without it */
  }

  const summary = {
    schema: 1,
    ticket: run.ticket,
    environment: run.env,
    runId: run.id,
    startedAt: state.createdAt || state.startedAt || null,
    updatedAt: new Date().toISOString(),
    verdict: verdictOf(path.join(run.dir, 'report.md')),
    phases,
    findings: { red, yellow, total: findings.length },
    artifacts: {
      screenshots: countFiles(run.sub.screenshots),
      recordings: countFiles(run.sub.recordings),
      trees: countFiles(run.sub.trees),
      api: countFiles(run.sub.api),
    },
    app,
    backendUrl,
    costUsd: cost && typeof cost.totalUsd === 'number' ? cost.totalUsd : null,
    files: {
      report: fs.existsSync(path.join(run.dir, 'report.md')) ? 'report.md' : null,
      plan: fs.existsSync(path.join(run.dir, 'plan.md')) ? 'plan.md' : null,
      state: 'state.json',
    },
  };
  fs.writeFileSync(path.join(run.dir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

// -------------------------------------------------------------------- index

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (_) {
    return false;
  }
}

// Every run on disk, newest first. Filters are optional.
function listRuns({ ticket, env } = {}) {
  const base = config.reportsDir();
  const out = [];
  for (const t of fs.readdirSync(base)) {
    if (t.startsWith('.') || t.startsWith('_') || !isDir(path.join(base, t))) continue;
    if (ticket && t !== safe(ticket)) continue;
    for (const e of fs.readdirSync(path.join(base, t))) {
      if (!isDir(path.join(base, t, e))) continue;
      if (env && e !== safe(env)) continue;
      const root = path.join(base, t, e);
      const pointer = path.join(root, 'current');
      const current = fs.existsSync(pointer) ? fs.readFileSync(pointer, 'utf8').trim() : null;
      for (const id of fs.readdirSync(root)) {
        if (!isDir(path.join(root, id))) continue;
        const run = runInfo(t, e, id);
        const summary = readJson(path.join(run.dir, 'summary.json')) || writeSummary(run);
        out.push({ ...run, current: id === current, summary });
      }
    }
  }
  return out.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

function rebuildIndex() {
  const base = config.reportsDir();
  const runs = listRuns();

  const rows = runs.map(r => ({
    ticket: r.ticket,
    environment: r.env,
    runId: r.id,
    current: r.current,
    verdict: r.summary.verdict,
    findings: r.summary.findings,
    updatedAt: r.summary.updatedAt,
    path: path.relative(base, r.dir),
  }));
  fs.writeFileSync(path.join(base, 'index.json'), `${JSON.stringify({ schema: 1, runs: rows }, null, 2)}\n`);

  const lines = [
    '# QC runs',
    '',
    'Generated by qc-check. Newest first. Each run folder holds its report, plan,',
    'state, `summary.json` and the evidence it captured.',
    '',
    '| Ticket | Env | Run | Verdict | Red | Yellow | Report |',
    '|--------|-----|-----|---------|-----|--------|--------|',
  ];
  for (const r of rows) {
    const report = r.path && fs.existsSync(path.join(base, r.path, 'report.md'))
      ? `[report](${r.path}/report.md)`
      : '-';
    lines.push(
      `| ${r.ticket} | ${r.environment} | ${r.runId}${r.current ? ' (current)' : ''} | ` +
        `${r.verdict || 'in progress'} | ${r.findings.red} | ${r.findings.yellow} | ${report} |`,
    );
  }
  if (rows.length === 0) lines.push('| - | - | - | no runs yet | - | - | - |');
  fs.writeFileSync(path.join(base, 'index.md'), `${lines.join('\n')}\n`);
  return rows;
}

module.exports = {
  KINDS,
  newRunId,
  openRun,
  currentRun,
  artifactPath,
  writeSummary,
  listRuns,
  rebuildIndex,
};

// ---------------------------------------------------------------------- CLI

function help() {
  process.stdout.write(`runs.js - where QC evidence lives.

Usage
  node qc/runs.js current                   the run in progress, as JSON
  node qc/runs.js open <ticket> [--env e] [--fresh]
                                            start or resume a run, print its folder
  node qc/runs.js path <kind> <name> <ext>  next numbered artifact path
                                            kind: ${KINDS.join(', ')}
  node qc/runs.js list [--ticket t] [--env e]
  node qc/runs.js index                     rebuild index.md and index.json
`);
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const flag = name => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const cmd = argv[0];
  try {
    if (!cmd || cmd === '--help' || cmd === '-h') {
      help();
    } else if (cmd === 'current') {
      const run = currentRun();
      process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
      process.exit(run ? 0 : 1);
    } else if (cmd === 'open') {
      const run = openRun({ ticket: argv[1], env: flag('env'), fresh: argv.includes('--fresh') });
      process.stdout.write(`${run.dir}\n`);
    } else if (cmd === 'path') {
      process.stdout.write(`${artifactPath(argv[1], argv[2], argv[3] || 'png')}\n`);
    } else if (cmd === 'list') {
      for (const r of listRuns({ ticket: flag('ticket'), env: flag('env') })) {
        process.stdout.write(
          `${r.ticket}\t${r.env}\t${r.id}${r.current ? ' *' : ''}\t${r.summary.verdict || 'in progress'}\n`,
        );
      }
    } else if (cmd === 'index') {
      const rows = rebuildIndex();
      process.stdout.write(`index rebuilt: ${rows.length} run(s)\n`);
    } else {
      help();
      process.exit(1);
    }
  } catch (err) {
    process.stderr.write(`ERROR: ${err.message}\n`);
    process.exit(1);
  }
}
