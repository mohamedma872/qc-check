'use strict';

// qc-check report: the finished report for a run, and the evidence beside it.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { info, fail, findHost, readConfig, RUNTIME_DIR } = require('./util');
const { resolveEnv, hostRuntime } = require('./envs');
const { pickRun } = require('./status');

function help() {
  info(`qc-check report - the report a run produced.

Usage
  qc-check report <ticket> [--env <name>] [--run <id>]
  qc-check report <ticket> --path       print the report path only
  qc-check report <ticket> --folder     print the run folder only
  qc-check report <ticket> --json       print summary.json
  qc-check report <ticket> --open       open the report in the system viewer

The report is assembled from evidence on disk, so it exists even when a run was
interrupted. A run with no report yet says which phase it stopped at.`);
}

function count(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => !f.startsWith('.')).length;
  } catch (_) {
    return 0;
  }
}

async function run(args) {
  const host = findHost(args);
  const cfg = readConfig(host, { required: true });

  const ticket = args._[0] ? String(args._[0]).toUpperCase() : null;
  if (!ticket) fail('which run? e.g. qc-check report ABC-123 --env sprint');
  if (!fs.existsSync(path.join(host, RUNTIME_DIR, 'runs.js'))) {
    fail('the runtime is missing or predates run folders. Run `qc-check setup`.');
  }

  const env = resolveEnv(cfg, args.env);
  const { runs } = hostRuntime(host, env);
  const runId = args.run && args.run !== true ? String(args.run) : null;
  const chosen = pickRun(runs.listRuns({ ticket }), ticket, env, runId);
  if (!chosen) {
    fail(`no run found for ${ticket} on ${env}. See \`qc-check status ${ticket}\`.`);
    return;
  }

  const summary = runs.writeSummary(chosen);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  if (args.folder) {
    process.stdout.write(`${chosen.dir}\n`);
    return;
  }

  const file = path.join(chosen.dir, 'report.md');
  if (!fs.existsSync(file)) {
    info(`No report for ${ticket} on ${chosen.env} yet. The run has not reached the report phase.`);
    info(`  where it stands:  qc-check status ${ticket} --env ${chosen.env}`);
    info(`  continue it:      qc-check run ${ticket} --env ${chosen.env}`);
    process.exit(1);
  }

  if (args.path) {
    process.stdout.write(`${file}\n`);
    return;
  }
  if (args.open) {
    spawnSync(process.platform === 'darwin' ? 'open' : 'xdg-open', [file], { stdio: 'ignore' });
    info(`opened ${path.relative(host, file)}`);
    return;
  }

  process.stdout.write(fs.readFileSync(file, 'utf8'));
  info('');
  info(`Run folder: ${chosen.dir}`);
  for (const kind of runs.KINDS) {
    const n = count(path.join(chosen.dir, kind));
    if (n) info(`  ${kind.padEnd(12)} ${n} file(s)`);
  }
  info(`  summary.json verdict ${summary.verdict || 'none'}, ${summary.findings.red} red, ${summary.findings.yellow} yellow`);
}

module.exports = { run, help };
