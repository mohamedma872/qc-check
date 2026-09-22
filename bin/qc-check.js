#!/usr/bin/env node
'use strict';

// qc-check: run mobile QC on a real device, driven by an AI agent.
//
//   qc-check setup            configure this repo, once
//   qc-check run ABC-123      QC a ticket
//   qc-check doctor           check the setup
//
// Zero dependencies on purpose: this is the thing you run first.

const { parseArgs, info, fail, pkgVersion } = require('../cli/util');

const COMMANDS = {
  setup: { file: '../cli/setup', blurb: 'configure this repository for QC (run this first)' },
  doctor: { file: '../cli/doctor', blurb: 'check the environment and configuration' },
  run: { file: '../cli/run', blurb: 'run a QC pass: a ticket, "all", or "fix <run-id>"' },
  prompt: { file: '../cli/prompt', blurb: 'print the QC prompt instead of running it' },
  status: { file: '../cli/status', blurb: 'show the state of a run, resumable at any point' },
  report: { file: '../cli/report', blurb: 'show or locate the report for a run' },
  install: { file: '../cli/install', blurb: 'also expose QC as a slash command in your agent' },
};

function usage() {
  info(`qc-check ${pkgVersion()} - mobile QC on a real device, driven by an AI agent.

Usage
  qc-check <command> [options]

Commands`);
  const width = Math.max(...Object.keys(COMMANDS).map((c) => c.length));
  for (const [name, { blurb }] of Object.entries(COMMANDS)) {
    info(`  ${name.padEnd(width)}   ${blurb}`);
  }
  info(`
Getting started
  cd /path/to/your/app
  qc-check setup                 detect the project and write qc.config.json
  qc-check doctor                confirm Appium, a device and an agent are ready
  qc-check run ABC-123           QC one ticket
  qc-check run all               sweep every screen
  qc-check run fix ABC-123       fix what the last run found

Common options
  --dir <path>    act on this repository instead of the current one
  --help          detailed help for a command, e.g. qc-check run --help

Docs: https://github.com/mohamedma872/qc-check#readme`);
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const cmd = args._[0];

  if (args.version || cmd === 'version') {
    info(pkgVersion());
    return;
  }
  if (!cmd || cmd === 'help') {
    if (args._[1] && COMMANDS[args._[1]]) {
      const mod = require(COMMANDS[args._[1]].file);
      return mod.help ? mod.help() : usage();
    }
    return usage();
  }

  const entry = COMMANDS[cmd];
  if (!entry) {
    fail(`unknown command "${cmd}". Run \`qc-check --help\` for the list.`);
    return;
  }

  const mod = require(entry.file);
  if (args.help && mod.help) return mod.help();

  // Drop the command name so each module sees only its own arguments.
  args._ = args._.slice(1);
  await mod.run(args);
}

main().catch((err) => {
  fail(err && err.stack ? err.stack : String(err));
});
