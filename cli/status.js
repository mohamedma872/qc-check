'use strict';

// qc-check status: what a run has done so far and where it would resume.
// The runtime's state.js is the authoritative formatter, so delegate to it
// when it is installed and fall back to reading the state file directly.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { info, fail, findHost, readConfig, reportsDirOf, RUNTIME_DIR } = require('./util');

function help() {
  info(`qc-check status - show the state of a QC run.

Usage
  qc-check status [<ticket>] [--dir <path>] [--json]

With no ticket, lists every run that has state on disk. A run is resumable:
whatever it says, \`qc-check run <ticket>\` picks up from there rather than
starting over.`);
}

function stateFiles(reportsDir) {
  if (!fs.existsSync(reportsDir)) return [];
  return fs
    .readdirSync(reportsDir)
    .filter((f) => f.endsWith('-state.json'))
    .map((f) => ({ ticket: f.replace(/-state\.json$/, ''), file: path.join(reportsDir, f) }));
}

async function run(args) {
  const host = findHost(args);
  const cfg = readConfig(host, { required: true });
  const reportsDir = reportsDirOf(host, cfg);
  const ticket = args._[0];

  if (!ticket) {
    const runs = stateFiles(reportsDir);
    if (runs.length === 0) {
      info(`No runs yet in ${path.relative(host, reportsDir) || '.'}.`);
      info('Start one with: qc-check run ABC-123');
      return;
    }
    info(`Runs in ${path.relative(host, reportsDir) || '.'}:`);
    info('');
    for (const r of runs) {
      let summary = '';
      try {
        const st = JSON.parse(fs.readFileSync(r.file, 'utf8'));
        const phases = st.phases || {};
        const done = Object.values(phases).filter((p) => p && p.status === 'pass').length;
        const total = Object.keys(phases).length;
        const findings = (st.findings || []).length;
        summary = `${done}/${total} phases, ${findings} finding(s)`;
      } catch (_) {
        summary = 'unreadable state file';
      }
      const reportPath = path.join(reportsDir, `${r.ticket}-report.md`);
      const hasReport = fs.existsSync(reportPath) ? ', report ready' : '';
      info(`  ${r.ticket.padEnd(14)} ${summary}${hasReport}`);
    }
    info('');
    info('Detail: qc-check status ABC-123');
    return;
  }

  const id = String(ticket).toUpperCase();
  const stateJs = path.join(host, RUNTIME_DIR, 'state.js');

  if (args.json) {
    const f = path.join(reportsDir, `${id}-state.json`);
    if (!fs.existsSync(f)) fail(`no run state for ${id} in ${path.relative(host, reportsDir)}`);
    process.stdout.write(fs.readFileSync(f, 'utf8'));
    return;
  }

  if (fs.existsSync(stateJs)) {
    const res = spawnSync(process.execPath, [stateJs, id, 'get'], { cwd: host, stdio: 'inherit' });
    process.exit(res.status === null ? 1 : res.status);
  }

  // Runtime not installed: read the file ourselves rather than refusing.
  const f = path.join(reportsDir, `${id}-state.json`);
  if (!fs.existsSync(f)) {
    fail(`no run state for ${id}. Start one with: qc-check run ${id}`);
  }
  const st = JSON.parse(fs.readFileSync(f, 'utf8'));
  info(`${id} - QC run state (runtime not installed, showing raw state)`);
  for (const [phase, v] of Object.entries(st.phases || {})) {
    info(`  ${phase.padEnd(12)} ${(v && v.status) || 'pending'}`);
  }
  for (const finding of st.findings || []) {
    info(`  ${String(finding.severity || '').toUpperCase()}: ${finding.text || finding}`);
  }
  info('');
  info(`Run \`qc-check setup\` to install the runtime for full detail.`);
}

module.exports = { run, help };
