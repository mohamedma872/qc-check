#!/usr/bin/env node
'use strict';

// Leak guard. This repo is published; the app it was extracted from is not.
//
// Rather than denylisting one project's names, this asserts the positive
// invariant: every concrete identifier in tracked files is an obvious
// placeholder. Anything else is a leak from a real configuration.
//
//   node test/no-private-refs.js
//
// Exits non-zero and prints file:line for every violation.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Hosts a public example may legitimately name.
const ALLOWED_HOSTS = [
  'example.com',
  'www.example.com',
  'api.staging.example.com',
  'api.example.com',
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  'github.com',
  'raw.githubusercontent.com',
  'json-schema.org',
  'opensource.org',
  'nodejs.org',
  'appium.io',
  'developer.android.com',
  'developer.apple.com',
  'your-org.atlassian.net', // the documented placeholder, not a real tenant
];

// Package / bundle identifiers a public example may contain.
const ALLOWED_PKG_PREFIXES = ['com.example.', 'io.appium.', 'com.android.', 'org.'];

// Ticket prefixes used in documentation.
const ALLOWED_TICKET_PREFIXES = ['ABC', 'PROJ', 'FULL', 'RUN', 'TICKET', 'ID', 'MD', 'JSON', 'API', 'UI', 'QC', 'DOD', 'TC', 'EN', 'AR', 'RTL', 'LTR', 'US', 'GB', 'PASS', 'FAIL', 'BLOCKED'];

const SKIP_DIRS = new Set(['.git', 'node_modules', 'qc-reports']);
const TEXT_EXT = new Set(['.js', '.json', '.md', '.yaml', '.yml', '.sh', '.txt']);

function trackedFiles() {
  try {
    // Tracked files plus anything staged or newly written but not ignored, so
    // a leak is caught before it is committed rather than after.
    const out = execFileSync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard'],
      { cwd: ROOT, encoding: 'utf8' },
    );
    return [...new Set(out.split('\n').filter(Boolean))];
  } catch (_) {
    // Not a git repo yet: walk the tree instead.
    const acc = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name));
        } else {
          acc.push(path.relative(ROOT, path.join(dir, e.name)));
        }
      }
    })(ROOT);
    return acc;
  }
}

const violations = [];

function report(file, lineNo, line, why) {
  violations.push({ file, lineNo, why, text: line.trim().slice(0, 160) });
}

for (const rel of trackedFiles()) {
  if (rel.startsWith('test/')) continue; // this file names the placeholders
  if (!TEXT_EXT.has(path.extname(rel))) continue;

  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) continue;
  const lines = fs.readFileSync(abs, 'utf8').split('\n');

  lines.forEach((line, i) => {
    const lineNo = i + 1;

    // A template-literal placeholder is a variable, not a hostname, so blank
    // interpolations out before looking for concrete identifiers.
    const scan = line.replace(/\$\{[^}]*\}/g, '$');

    // 1. URLs must point at an allowed host.
    const urls = scan.match(/https?:\/\/[^\s"'`)<>\]$]+/g) || [];
    for (const u of urls) {
      let host;
      try {
        host = new URL(u).hostname;
      } catch (_) {
        continue;
      }
      if (!ALLOWED_HOSTS.includes(host)) {
        report(rel, lineNo, line, `URL host "${host}" is not a placeholder`);
      }
    }

    // 2. Reverse-DNS application identifiers must be example packages.
    // Deliberately narrow: only strings that start with a TLD-like segment,
    // so dotted code paths such as util.inspect.custom are not candidates.
    const pkgs = scan.match(/(?<![.\w])(?:com|net|org|io|co|dev|ai|me)(?:\.[a-zA-Z][a-zA-Z0-9_]*){2,}\b/g) || [];
    for (const p of pkgs) {
      if (ALLOWED_PKG_PREFIXES.some((pre) => p.startsWith(pre))) continue;
      report(rel, lineNo, line, `identifier "${p}" looks like a real package id`);
    }

    // 3. Ticket ids must use a documented placeholder prefix.
    const tickets = scan.match(/\b[A-Z]{2,10}-\d{1,6}\b/g) || [];
    for (const t of tickets) {
      const prefix = t.split('-')[0];
      if (!ALLOWED_TICKET_PREFIXES.includes(prefix)) {
        report(rel, lineNo, line, `ticket id "${t}" uses a non-placeholder prefix`);
      }
    }

    // 4. No device serial pinned in configuration, where it would take effect.
    // Prose and shell examples may name one; a shipped config may not.
    if (path.extname(rel) === '.json') {
      const udids = scan.match(/\bemulator-\d{4,}\b/g) || [];
      for (const u of udids) report(rel, lineNo, line, `pinned device serial "${u}"`);
    }
  });
}

if (violations.length === 0) {
  process.stdout.write('no-private-refs: clean\n');
  process.exit(0);
}

process.stderr.write(`no-private-refs: ${violations.length} violation(s)\n\n`);
for (const v of violations) {
  process.stderr.write(`  ${v.file}:${v.lineNo}  ${v.why}\n      ${v.text}\n`);
}
process.exit(1);
