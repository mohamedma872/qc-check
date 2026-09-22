'use strict';

// qc-check report: the finished report and the evidence beside it.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { info, fail, findHost, readConfig, reportsDirOf } = require('./util');

function help() {
  info(`qc-check report - show the report a run produced.

Usage
  qc-check report <ticket> [--dir <path>] [--path] [--open]

  --path   print the file path only, for piping
  --open   open it in the system viewer

The report is assembled from evidence on disk, so it exists even when a run was
interrupted. A run with no report yet will say which phase it stopped at.`);
}

function listEvidence(reportsDir, id) {
  if (!fs.existsSync(reportsDir)) return [];
  return fs
    .readdirSync(reportsDir)
    .filter((f) => f.startsWith(`${id}`) && !f.endsWith('-report.md'))
    .sort();
}

async function run(args) {
  const host = findHost(args);
  const cfg = readConfig(host, { required: true });
  const reportsDir = reportsDirOf(host, cfg);

  const ticket = args._[0];
  if (!ticket) fail('which run? e.g. qc-check report ABC-123');

  const id = String(ticket).toUpperCase();
  const file = path.join(reportsDir, `${id}-report.md`);

  if (!fs.existsSync(file)) {
    const state = path.join(reportsDir, `${id}-state.json`);
    if (fs.existsSync(state)) {
      info(`No report for ${id} yet. The run has not reached the report phase.`);
      info(`Where it stands:  qc-check status ${id}`);
      info(`Continue it:      qc-check run ${id}`);
      process.exit(1);
    }
    fail(`no run found for ${id} in ${path.relative(host, reportsDir) || '.'}`);
  }

  if (args.path) {
    process.stdout.write(`${file}\n`);
    return;
  }

  if (args.open) {
    const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawnSync(opener, [file], { stdio: 'ignore' });
    info(`opened ${path.relative(host, file)}`);
    return;
  }

  process.stdout.write(fs.readFileSync(file, 'utf8'));

  const evidence = listEvidence(reportsDir, id);
  if (evidence.length) {
    info('');
    info(`Evidence in ${path.relative(host, reportsDir) || '.'}: ${evidence.length} file(s)`);
    for (const f of evidence.slice(0, 12)) info(`  ${f}`);
    if (evidence.length > 12) info(`  ... and ${evidence.length - 12} more`);
  }
}

module.exports = { run, help };
