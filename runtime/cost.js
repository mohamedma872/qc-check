#!/usr/bin/env node
// QC - per-run token/cost tracking. Keeps per-ticket snapshots of the agent's
// token usage so a QC run's real spend is on disk next to the rest of the run
// evidence, and so a run can be stopped when it passes the configured budget.
//
// Usage source: agents differ in what they expose. Claude Code writes a session
// transcript (~/.claude/projects/<slug>/<session>.jsonl) that this script sums.
// Any other agent (Codex, a generic shell runner, CI) has no such file, so
// usage is recorded as "unavailable" and the snapshot is still written - the
// run must never fail because token accounting is missing.
// Set QC_USAGE_SOURCE=none to force that path.
//
// Data:   <run dir>/cost.json  (snapshots, source of truth; top-level totalUsd)
// Report: <run dir>/cost.md    (regenerated from the JSON)
// The run dir is <reportsDir>/<TICKET>/<env>/<run-id>/, resolved exactly as
// state.js does (runs.js), so cost always sits next to the state it prices.
//
// Usage:
//   node runtime/cost.js <TICKET> snapshot <label...>   # record cumulative usage now (e.g. baseline, phone:pass)
//   node runtime/cost.js <TICKET> get [--json]          # print run summary
//   node runtime/cost.js <TICKET> reset                 # clear this run's cost data
//
// Snapshots are cumulative per session; deltas between consecutive snapshots in
// the same session attribute cost to phases. The first snapshot in a session is
// the baseline for that session (take one labeled `baseline` at run start or
// resume so pre-QC conversation in a mixed session is not billed to the run).
// state.js auto-snapshots on every phase `set`, so per-phase data accrues even
// if nobody remembers to call this directly.
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// USD per 1M tokens (API sticker prices, cached 2026-07-20).
// Cache write: 1.25x input (5m TTL) / 2x input (1h TTL). Cache read: 0.1x input.
const PRICING = [
  { match: /^claude-(fable|mythos)-5/, in: 10, out: 50 },
  { match: /^claude-opus-4/, in: 5, out: 25 },
  { match: /^claude-sonnet/, in: 3, out: 15 },
  { match: /^claude-haiku/, in: 1, out: 5 },
];

const [ticketArg, cmd, ...rest] = process.argv.slice(2);
const ticket = (ticketArg || '').toUpperCase();

const USAGE = 'usage: cost.js <TICKET> snapshot <label> | get [--json] | reset';

function usage() {
  console.error(USAGE);
  process.exit(1);
}

// Paths and config are resolved lazily: require()ing this module for its pure
// helpers (a guard, an eval grader) must not need a qc.config.json.
let cached = null;
function files() {
  if (!cached) {
    const config = require('./config.js');
    const runs = require('./runs.js');
    const env = config.activeEnv();
    // Same rule as state.js: QC_RUN_DIR wins when it names this ticket and env.
    const fromEnv = process.env.QC_RUN_DIR ? runs.currentRun() : null;
    const run = fromEnv && fromEnv.ticket === ticket && fromEnv.env === env
      ? fromEnv
      : runs.openRun({ ticket, env });
    cached = {
      run,
      runs,
      json: path.join(run.dir, 'cost.json'),
      md: path.join(run.dir, 'cost.md'),
    };
  }
  return cached;
}

// summary.json reads cost.totalUsd; a failure here must not fail the snapshot.
function publish() {
  try {
    files().runs.writeSummary(files().run);
    files().runs.rebuildIndex();
  } catch { /* summary is derived data; the next write rebuilds it */ }
}

function cap() {
  try {
    return require('./config.js').budgetCap();
  } catch {
    return 0;
  }
}

function transcriptDirs() {
  const home = require('os').homedir();
  const roots = new Set([process.cwd()]);
  try {
    roots.add(require('./config.js').findRepoRoot());
  } catch { /* config may not expose it, or there may be no config */ }
  return [...roots].map(r => path.join(home, '.claude', 'projects', r.replace(/[^a-zA-Z0-9]/g, '-')));
}

// The active session. CLAUDE_CODE_SESSION_ID (set in Claude Code's Bash env)
// pins it exactly; without it, fall back to the most recently written
// transcript - ambiguous when two sessions run in this project concurrently.
function currentTranscript() {
  for (const dir of transcriptDirs()) {
    if (!fs.existsSync(dir)) {continue;}
    const sid = process.env.CLAUDE_CODE_SESSION_ID;
    if (sid) {
      const pinned = path.join(dir, `${sid}.jsonl`);
      if (fs.existsSync(pinned)) {return pinned;}
    }
    const found = fs.readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({ f: path.join(dir, f), m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    if (found.length) {return found[0].f;}
  }
  return null;
}

function emptyTotals() {
  return { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };
}

function addUsage(t, u) {
  t.input += u.input_tokens || 0;
  t.output += u.output_tokens || 0;
  t.cacheRead += u.cache_read_input_tokens || 0;
  if (u.cache_creation) {
    t.cacheWrite5m += u.cache_creation.ephemeral_5m_input_tokens || 0;
    t.cacheWrite1h += u.cache_creation.ephemeral_1h_input_tokens || 0;
  } else {
    t.cacheWrite5m += u.cache_creation_input_tokens || 0;
  }
}

function costUSD(model, t) {
  const p = PRICING.find(x => x.match.test(model));
  if (!p) {return null;}
  return (t.input * p.in + t.output * p.out + t.cacheRead * p.in * 0.1
    + t.cacheWrite5m * p.in * 1.25 + t.cacheWrite1h * p.in * 2) / 1e6;
}

// Sum a session transcript. Lines duplicate usage (one line per content block
// of the same API response), so dedupe on requestId + message id.
async function sumTranscript(file) {
  const byModel = {};
  const seen = new Set();
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'assistant' || !o.message || !o.message.usage) {continue;}
    const model = o.message.model;
    if (!model || model === '<synthetic>') {continue;}
    const key = `${o.requestId || ''}:${o.message.id || o.uuid}`;
    if (seen.has(key)) {continue;}
    seen.add(key);
    addUsage(byModel[model] || (byModel[model] = emptyTotals()), o.message.usage);
  }
  return byModel;
}

function sumModels(byModel) {
  const t = emptyTotals();
  let cost = 0;
  let unpriced = false;
  for (const [model, m] of Object.entries(byModel)) {
    for (const k of Object.keys(t)) {t[k] += m[k];}
    const c = costUSD(model, m);
    if (c === null) {unpriced = true;} else {cost += c;}
  }
  return { ...t, cost, unpriced };
}

function diffModels(now, base) {
  const out = {};
  for (const [model, m] of Object.entries(now)) {
    const b = (base && base[model]) || emptyTotals();
    const d = emptyTotals();
    for (const k of Object.keys(d)) {d[k] = Math.max(0, m[k] - b[k]);}
    if (Object.values(d).some(v => v > 0)) {out[model] = d;}
  }
  return out;
}

function load() {
  if (!fs.existsSync(files().json)) {return { ticket, snapshots: [] };}
  return JSON.parse(fs.readFileSync(files().json, 'utf8'));
}

function save(data) {
  // Always numeric, so summary.json can read it without a type check. 0 when
  // nothing was measured; usageMeasured says which.
  const t = runTotals(data);
  data.totalUsd = measured(data) ? Math.round(t.cost * 1e6) / 1e6 : 0;
  data.usageMeasured = measured(data);
  data.env = files().run.env;
  data.runId = files().run.id;
  fs.mkdirSync(path.dirname(files().json), { recursive: true });
  fs.writeFileSync(files().json, JSON.stringify(data, null, 2) + '\n');
  fs.writeFileSync(files().md, renderMd(data));
  publish();
}

function fmtTok(n) {
  if (n >= 1e6) {return (n / 1e6).toFixed(2) + 'M';}
  if (n >= 1e3) {return (n / 1e3).toFixed(1) + 'k';}
  return String(n);
}

function fmtUSD(c, unpriced) {
  return `$${c.toFixed(2)}${unpriced ? '+?' : ''}`;
}

// Per session: contribution = last snapshot - first snapshot (the first is the
// baseline; whatever the session spent before it does not belong to this run).
function runTotals(data) {
  const bySession = {};
  for (const s of data.snapshots) {(bySession[s.sessionId] || (bySession[s.sessionId] = [])).push(s);}
  const total = emptyTotals();
  let cost = 0;
  let unpriced = false;
  for (const snaps of Object.values(bySession)) {
    const d = sumModels(diffModels(snaps[snaps.length - 1].byModel, snaps[0].byModel));
    for (const k of Object.keys(total)) {total[k] += d[k];}
    cost += d.cost;
    unpriced = unpriced || d.unpriced;
  }
  return { ...total, cost, unpriced, sessions: Object.keys(bySession).length };
}

function measured(data) {
  return data.snapshots.some(s => s.usage !== 'unavailable');
}

function budgetLine(data) {
  const limit = cap();
  const t = runTotals(data);
  if (!measured(data)) {
    return `**Budget**: cap ${fmtUSD(limit, false)} - usage unavailable for this agent, spend not measured.`;
  }
  const pct = limit > 0 ? Math.round((t.cost / limit) * 100) : 0;
  const over = limit > 0 && t.cost >= limit;
  return `**Budget**: ${fmtUSD(t.cost, t.unpriced)} of ${fmtUSD(limit, false)} cap (${pct}%)${over ? ' - OVER CAP, stop and ask the user' : ''}.`;
}

function renderMd(data) {
  const t = runTotals(data);
  const lines = [];
  lines.push(`# ${data.ticket} - QC run cost`);
  lines.push('');
  lines.push('_Auto-generated by `cost.js` - do not edit. Data: `' + path.basename(files().json) + '`._');
  lines.push('');
  lines.push(`**Run total** (${t.sessions} session${t.sessions === 1 ? '' : 's'}, baseline-adjusted): ` +
    `**${fmtUSD(t.cost, t.unpriced)}** - output ${fmtTok(t.output)}, fresh input ${fmtTok(t.input)}, ` +
    `cache write ${fmtTok(t.cacheWrite5m + t.cacheWrite1h)}, cache read ${fmtTok(t.cacheRead)}`);
  lines.push('');
  lines.push(budgetLine(data));
  lines.push('');
  lines.push('| When | Label | Session | Usage | D output | D input | D cache write | D cache read | D est. cost |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  const prevBySession = {};
  for (const s of data.snapshots) {
    const d = sumModels(diffModels(s.byModel, prevBySession[s.sessionId]));
    prevBySession[s.sessionId] = s.byModel;
    lines.push(`| ${s.at.replace('T', ' ').slice(0, 16)} | ${s.label} | ${String(s.sessionId).slice(0, 8)} ` +
      `| ${s.usage || 'unknown'} | ${fmtTok(d.output)} | ${fmtTok(d.input)} | ${fmtTok(d.cacheWrite5m + d.cacheWrite1h)} ` +
      `| ${fmtTok(d.cacheRead)} | ${fmtUSD(d.cost, d.unpriced)} |`);
  }
  lines.push('');
  lines.push('_Cost = API sticker prices (see PRICING in cost.js; cached 2026-07-20). On a subscription plan this is_');
  lines.push('_equivalent-API-value, not a bill. The first snapshot of each session is its baseline (its row shows the_');
  lines.push('_session\'s pre-existing spend and is excluded from the run total). Rows marked `unavailable` come from an_');
  lines.push('_agent that does not expose token usage: the phase transition is recorded, the spend is not._');
  lines.push('');
  return lines.join('\n');
}

// Library use (a guard, an eval grader): require() gives the pure helpers
// without running the CLI and without needing a config on disk.
module.exports = { runTotals, sumModels, diffModels, emptyTotals, PRICING };

if (require.main === module) {
  if (ticketArg === '--help' || ticketArg === '-h' || cmd === '--help') {
    console.log(USAGE);
    console.log('');
    console.log('Writes <project.reportsDir>/<TICKET>/<env>/<run-id>/cost.{json,md} (env: QC_ENV or backend.defaultEnv).');
    console.log('Token usage is read from the Claude Code session transcript when there is one;');
    console.log('on any other agent it is recorded as "unavailable" and the run continues.');
    console.log('QC_USAGE_SOURCE=none forces "unavailable". Budget cap: budget.runCap or QC_BUDGET.');
    process.exit(0);
  }
  if (!ticketArg || !cmd) {usage();}
  (async () => {
    switch (cmd) {
      case 'snapshot': {
        const label = rest.join(' ').trim();
        if (!label) {usage();}
        const file = process.env.QC_USAGE_SOURCE === 'none' ? null : currentTranscript();
        let byModel = {};
        let source = 'unavailable';
        let sessionId = process.env.QC_SESSION_ID || 'unavailable';
        if (file) {
          try {
            byModel = await sumTranscript(file);
            source = 'claude-code';
            sessionId = path.basename(file, '.jsonl');
          } catch {
            byModel = {};
            source = 'unavailable';
          }
        }
        const data = load();
        data.snapshots.push({ at: new Date().toISOString(), label, sessionId, usage: source, byModel });
        save(data);
        const t = runTotals(data);
        if (source === 'unavailable') {
          console.log(`${ticket} cost snapshot "${label}" -> token usage unavailable for this agent (snapshot recorded)`);
          break;
        }
        console.log(`${ticket} cost snapshot "${label}" -> run total ${fmtUSD(t.cost, t.unpriced)} ` +
          `(out ${fmtTok(t.output)}, in ${fmtTok(t.input)}, cache r ${fmtTok(t.cacheRead)})`);
        const limit = cap();
        if (limit > 0 && t.cost >= limit) {
          console.error(`budget cap reached: ${fmtUSD(t.cost, t.unpriced)} of ${fmtUSD(limit, false)} - stop and ask the user before continuing`);
        }
        break;
      }
      case 'get': {
        const data = load();
        // Refresh the files on every read so cost.json always carries a
        // current totalUsd, even for a run with no snapshots yet.
        save(data);
        if (!data.snapshots.length) {
          console.log(`(no cost data for ${ticket})`);
          break;
        }
        if (rest.includes('--json')) {
          console.log(JSON.stringify({ ...data, budgetCap: cap(), runTotals: runTotals(data) }, null, 2));
        } else {
          console.log(renderMd(data));
        }
        break;
      }
      case 'reset': {
        for (const f of [files().json, files().md]) {if (fs.existsSync(f)) {fs.unlinkSync(f);}}
        publish();
        console.log(`cost data for ${ticket} cleared`);
        break;
      }
      default:
        usage();
    }
  })();
}
