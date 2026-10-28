#!/usr/bin/env node
'use strict';
// Fail-closed, deterministic validation of qc-check summary and evidence.
const fs = require('fs');
const path = require('path');
function evaluate(summary, root) {
  const errors = [];
  if (!summary || typeof summary !== 'object') return { pass: false, errors: ['missing or invalid summary'] };
  if (summary.verdict !== 'PASS') errors.push('verdict must be PASS');
  for (const key of ['ticket','environment','runId','startedAt']) {
    if (typeof summary[key] !== 'string' || !summary[key].trim()) errors.push('missing ' + key);
  }
  if (!summary.phases || typeof summary.phases !== 'object' || !Object.keys(summary.phases).length) errors.push('missing phases');
  else for (const [phase, status] of Object.entries(summary.phases)) {
    if (!['passed','pass','completed','done','skipped'].includes(String(status).toLowerCase())) errors.push('unfinished phase: ' + phase);
    if (['skipped'].includes(String(status).toLowerCase())) errors.push('skipped phase: ' + phase);
  }
  if (!summary.findings || !Number.isInteger(summary.findings.red) || summary.findings.red !== 0) errors.push('red findings present or unknown');
  if (!summary.artifacts || !Number.isInteger(summary.artifacts.screenshots) || summary.artifacts.screenshots < 1) errors.push('missing screenshot evidence');
  if (!root || !fs.existsSync(path.join(root,'report.md'))) errors.push('missing report.md');
  if (!root || !fs.existsSync(path.join(root,'state.json'))) errors.push('missing state.json');
  const screenshots = root && path.join(root,'screenshots');
  if (!screenshots || !fs.existsSync(screenshots) || fs.readdirSync(screenshots).filter(n => /\.png$|\.jpg$|\.jpeg$/i.test(n)).length < 1) errors.push('no screenshot files');
  // A summary alone cannot establish screenshot provenance, build SHA, or device identity.
  // Such attestations require a separately verified evidence manifest.
  const manifestFile = root && path.join(root,'evidence-manifest.json');
  if (!manifestFile || !fs.existsSync(manifestFile)) errors.push('missing evidence-manifest.json');
  else {
    let m;
    try { m = JSON.parse(fs.readFileSync(manifestFile,'utf8')); } catch (_) { errors.push('invalid evidence manifest'); }
    if (m) {
      for (const key of ['commitSha','deviceId','osVersion','agentVersion','capturedAt']) {
        if (typeof m[key] !== 'string' || !m[key].trim()) errors.push('missing manifest ' + key);
      }
      if (m.environment !== summary.environment || m.runId !== summary.runId) errors.push('manifest identity mismatch');
      if (m.reviewed !== true) errors.push('evidence not independently reviewed');
    }
  }
  return { pass: errors.length === 0, errors };
}
if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) { console.error('Usage: node runtime/quality-gate.js <run-directory>'); process.exit(2); }
  let summary;
  try { summary = JSON.parse(fs.readFileSync(path.join(dir,'summary.json'),'utf8')); } catch (_) {}
  const result = evaluate(summary,dir);
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
  process.exit(result.pass ? 0 : 1);
}
module.exports = { evaluate };
