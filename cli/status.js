'use strict';

// qc-check status: what runs exist, and what one run has done so far.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { info, fail, heading, findHost, readConfig, reportsDirOf, RUNTIME_DIR } = require('./util');
const { resolveEnv, hostRuntime, listEnvs } = require('./envs');

function help() {
  info(`qc-check status - runs on disk, and where one of them stands.

Usage
  qc-check status                       every run, newest first
  qc-check status <ticket>              the current run for the default environment
  qc-check status <ticket> --env uat    the current run for one environment
  qc-check status <ticket> --run <id>   a specific earlier run
  qc-check status <ticket> --json       its summary.json

A run is resumable: \`qc-check run <ticket> --env <env>\` continues the current
run for that environment rather than starting over.`);
}

function legacyFiles(reportsDir) {
  if (!fs.existsSync(reportsDir)) return 0;
  return fs
    .readdirSync(reportsDir)
    .filter((f) => fs.statSync(path.join(reportsDir, f)).isFile())
    .filter((f) => !/^(index\.(md|json)|\.active\.json)$/.test(f)).length;
}

// Pick one run: an explicit id, else the current run for the environment.
function pickRun(runsList, ticket, env, runId) {
  const mine = runsList.filter((r) => r.ticket === ticket);
  if (runId) return mine.find((r) => r.id === runId) || null;
  return mine.find((r) => r.env === env && r.current) || mine.find((r) => r.env === env) || null;
}

async function run(args) {
  const host = findHost(args);
  const cfg = readConfig(host, { required: true });
  const reportsDir = reportsDirOf(host, cfg);
  const ticket = args._[0] ? String(args._[0]).toUpperCase() : null;

  if (!fs.existsSync(path.join(host, RUNTIME_DIR, 'runs.js'))) {
    fail('the runtime is missing or predates run folders. Run `qc-check setup`.');
  }
  const env = resolveEnv(cfg, args.env);
  const { runs } = hostRuntime(host, env);
  const all = runs.listRuns();

  if (!ticket) {
    runs.rebuildIndex();
    if (all.length === 0) {
      info(`No runs yet in ${path.relative(host, reportsDir) || '.'}.`);
      info('Start one with: qc-check run ABC-123');
    } else {
      heading(`Runs in ${path.relative(host, reportsDir) || '.'} (newest first)`);
      info(`  ${'ticket'.padEnd(14)} ${'env'.padEnd(10)} ${'run'.padEnd(22)} ${'verdict'.padEnd(12)} findings`);
      for (const r of all) {
        const s = r.summary;
        info(
          `  ${r.ticket.padEnd(14)} ${r.env.padEnd(10)} ${(r.id + (r.current ? ' *' : '')).padEnd(22)} ` +
            `${String(s.verdict || 'in progress').padEnd(12)} ${s.findings.red} red, ${s.findings.yellow} yellow`,
        );
      }
      info('');
      info('  * the run a re-run resumes');
      info(`  index: ${path.join(reportsDir, 'index.md')}`);
    }
    const legacy = legacyFiles(reportsDir);
    if (legacy) {
      info('');
      info(`  ${legacy} older file(s) sit loose in ${path.relative(host, reportsDir)}/ from before run folders.`);
      info('  They are left as they are; move or delete them when you no longer need them.');
    }
    return;
  }

  const runId = args.run && args.run !== true ? String(args.run) : null;
  const chosen = pickRun(all, ticket, env, runId);
  if (!chosen) {
    const elsewhere = [...new Set(all.filter((r) => r.ticket === ticket).map((r) => r.env))];
    if (elsewhere.length) {
      fail(
        `no ${runId ? `run ${runId}` : 'run'} for ${ticket} on ${env}. It has runs on: ${elsewhere.join(', ')}.\n` +
          `  Try: qc-check status ${ticket} --env ${elsewhere[0]}`,
      );
    }
    fail(`no run for ${ticket}. Start one with: qc-check run ${ticket} --env ${env}`);
    return;
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(runs.writeSummary(chosen), null, 2)}\n`);
    return;
  }

  info(`${ticket} on ${chosen.env}, run ${chosen.id}${chosen.current ? ' (current)' : ''}`);
  info(`folder: ${chosen.dir}`);
  info('');

  // The current run is what state.js resumes, so its formatter is exact.
  if (chosen.current) {
    const res = spawnSync(process.execPath, [path.join(host, RUNTIME_DIR, 'state.js'), ticket, 'get'], {
      cwd: host,
      stdio: 'inherit',
      env: { ...process.env, QC_ENV: chosen.env, QC_RUN_DIR: chosen.dir },
    });
    if (res.status !== 0) process.exitCode = res.status || 1;
  } else {
    const s = runs.writeSummary(chosen);
    for (const [phase, status] of Object.entries(s.phases)) info(`  ${phase.padEnd(12)} ${status}`);
    info('');
    info(`  verdict   ${s.verdict || 'no report'}`);
    info(`  findings  ${s.findings.red} red, ${s.findings.yellow} yellow`);
  }

  const others = all.filter((r) => r.ticket === ticket && r !== chosen);
  if (others.length) {
    info('');
    info(`Other runs of ${ticket}:`);
    for (const r of others) {
      info(`  ${r.env.padEnd(10)} ${r.id}${r.current ? ' *' : ''}  ${r.summary.verdict || 'in progress'}`);
    }
  }

  const known = listEnvs(cfg);
  if (known.length > 1 && !args.env) {
    info('');
    info(`Environments: ${known.join(', ')}. Pick one with --env.`);
  }
}

module.exports = { run, help, pickRun };
