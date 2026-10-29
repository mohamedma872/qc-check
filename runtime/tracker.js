#!/usr/bin/env node
// QC - Jira REST client, the alternative to an MCP tracker tool.
//
// Used when tracker.kind is "jira" and tracker.rest.enabled is true. The site,
// account email and API token come from the environment variables named in
// tracker.rest (defaults JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN). They are
// never printed, and never written to a file.
//
// Usage:
//   node qc/tracker.js check                         # can we reach Jira? prints the account name
//   node qc/tracker.js get ABC-123 [--json] [--save] # the ticket as markdown; --save writes <run>/ticket.md
//   node qc/tracker.js comment ABC-123 --file <path> # post a file's text as a comment
//   node qc/tracker.js attach ABC-123 <file>...      # upload files as attachments
//   node qc/tracker.js labels ABC-123 [--add a,b] [--remove c]
//
// Exit codes: 0 ok | 1 usage/config | 2 auth failed | 3 not found | 4 other HTTP error
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const args = process.argv.slice(2);

const HELP = [
  'tracker.js - Jira REST client for QC (tracker.rest in qc.config.json).',
  '',
  'Usage:',
  '  tracker.js check                          reach Jira, print the account name',
  '  tracker.js get <KEY> [--json] [--save]    the ticket as markdown (--save: <run>/ticket.md)',
  '  tracker.js comment <KEY> --file <path>    post the file as a comment',
  '  tracker.js attach <KEY> <file>...         upload attachments',
  '  tracker.js labels <KEY> [--add a,b] [--remove c]',
  '',
  'Auth: the env vars named by tracker.rest.baseUrlEnv / emailEnv / tokenEnv',
  '(defaults JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN). Values are never printed.',
  'Exit codes: 0 ok | 1 usage/config | 2 auth failed | 3 not found | 4 other HTTP error',
].join('\n');

if (!args.length || args.includes('--help') || args.includes('-h')) {
  console.log(HELP);
  process.exit(args.length ? 0 : 1);
}

const { loadConfig, validateTicket } = require('./config.js');

const cfg = loadConfig();
const tracker = cfg.tracker || {};
const rest = tracker.rest || {};

function fail(message, code) {
  console.error(message);
  process.exit(code || 1);
}

if (tracker.kind !== 'jira' || !rest.enabled) {
  fail('tracker.js needs tracker.kind "jira" and tracker.rest.enabled true in qc.config.json');
}

const names = {
  base: rest.baseUrlEnv || 'JIRA_BASE_URL',
  email: rest.emailEnv || 'JIRA_EMAIL',
  token: rest.tokenEnv || 'JIRA_API_TOKEN',
};
const missing = Object.values(names).filter(n => !process.env[n]);
if (missing.length) {
  fail(`Jira credentials are not in the environment: set ${missing.join(', ')} (for example in your shell profile)`);
}
let BASE = String(process.env[names.base]).replace(/\/+$/, '');
if (!/^https?:\/\//.test(BASE)) { BASE = `https://${BASE}`; }
const SECRET = process.env[names.token];
const AUTH = `Basic ${Buffer.from(`${process.env[names.email]}:${SECRET}`).toString('base64')}`;

function redact(text) {
  return String(text).split(SECRET).join('***');
}

function request(method, apiPath, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + apiPath);
    const transport = url.protocol === 'http:' ? http : https;
    const data = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: url.pathname + url.search,
        method,
        timeout: 30000,
        headers: {
          Authorization: AUTH,
          Accept: 'application/json',
          ...(data && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}),
          ...(data ? { 'Content-Length': data.length } : {}),
          ...(headers || {}),
        },
      },
      res => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', c => { raw += c; });
        res.on('end', () => {
          let json = null;
          try { json = raw ? JSON.parse(raw) : null; } catch { json = null; }
          resolve({ status: res.statusCode, json, raw });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout after 30s')));
    req.on('error', reject);
    if (data) { req.write(data); }
    req.end();
  });
}

async function call(method, apiPath, opts) {
  const res = await request(method, apiPath, opts);
  if (res.status === 401 || res.status === 403) {
    fail(`AUTHFAIL (HTTP ${res.status}) on ${method} ${apiPath}: check ${names.email} / ${names.token}`, 2);
  }
  if (res.status === 404) { fail(`NOT FOUND (HTTP 404) on ${method} ${apiPath}`, 3); }
  if (res.status >= 400) {
    const why = res.json && (res.json.errorMessages || res.json.errors)
      ? JSON.stringify(res.json.errorMessages || res.json.errors) : res.raw.slice(0, 300);
    fail(`HTTP ${res.status} on ${method} ${apiPath}: ${redact(why)}`, 4);
  }
  return res.json;
}

function issueKey(i) {
  const key = String(args[i] || '').toUpperCase();
  if (!key || !validateTicket(key)) { fail(`not a valid ticket id: "${args[i] || ''}"`); }
  return key;
}

function flagValue(name) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : null;
}

// --- Atlassian Document Format -> markdown --------------------------------

function inline(nodes) {
  return (nodes || []).map(n => {
    if (n.type === 'text') {
      let t = n.text || '';
      for (const m of n.marks || []) {
        if (m.type === 'strong') { t = `**${t}**`; }
        else if (m.type === 'em') { t = `_${t}_`; }
        else if (m.type === 'code') { t = `\`${t}\``; }
        else if (m.type === 'link' && m.attrs && m.attrs.href) { t = `[${t}](${m.attrs.href})`; }
      }
      return t;
    }
    if (n.type === 'hardBreak') { return '\n'; }
    if (n.type === 'mention') { return `@${(n.attrs && n.attrs.text || '').replace(/^@/, '')}`; }
    if (n.type === 'emoji') { return (n.attrs && n.attrs.text) || ''; }
    if (n.type === 'inlineCard') { return (n.attrs && n.attrs.url) || ''; }
    if (n.type === 'status') { return `[${(n.attrs && n.attrs.text) || ''}]`; }
    return inline(n.content);
  }).join('');
}

function block(node, indent) {
  const pad = '  '.repeat(indent);
  const kids = node.content || [];
  switch (node.type) {
    case 'doc': return kids.map(k => block(k, indent)).filter(Boolean).join('\n\n');
    case 'paragraph': return pad + inline(kids);
    case 'heading': return `${'#'.repeat(Math.min((node.attrs && node.attrs.level) || 3, 6))} ${inline(kids)}`;
    case 'bulletList':
    case 'orderedList':
      return kids.map((li, i) => {
        const marker = node.type === 'orderedList' ? `${i + 1}.` : '-';
        const parts = (li.content || []).map(c => (c.type === 'paragraph' ? inline(c.content) : `\n${block(c, indent + 1)}`));
        return `${pad}${marker} ${parts.join('')}`;
      }).join('\n');
    case 'taskList':
      return kids.map(t => `${pad}- [${t.attrs && t.attrs.state === 'DONE' ? 'x' : ' '}] ${inline(t.content)}`).join('\n');
    case 'codeBlock': return `\`\`\`\n${inline(kids)}\n\`\`\``;
    case 'blockquote': return kids.map(k => `> ${block(k, 0)}`).join('\n');
    case 'rule': return '---';
    case 'panel': return kids.map(k => block(k, indent)).join('\n\n');
    case 'table':
      return kids.map((row, r) => {
        const cells = (row.content || []).map(c => (c.content || []).map(p => block(p, 0)).join(' ').replace(/\|/g, '\\|').replace(/\n/g, ' '));
        const line = `| ${cells.join(' | ')} |`;
        return r === 0 ? `${line}\n|${cells.map(() => '---').join('|')}|` : line;
      }).join('\n');
    case 'mediaSingle':
    case 'mediaGroup': return `${pad}(embedded media)`;
    default: return kids.length ? kids.map(k => block(k, indent)).join('\n') : inline([node]);
  }
}

function adf(value) {
  if (value == null) { return ''; }
  if (typeof value === 'string') { return value; }
  return block(value, 0).replace(/\n{3,}/g, '\n\n').trim();
}

// --- commands ----------------------------------------------------------------

async function getIssue() {
  const key = issueKey(1);
  const acField = rest.acceptanceField || '';
  const fields = ['summary', 'status', 'issuetype', 'assignee', 'reporter', 'priority', 'labels',
    'description', 'issuelinks', 'subtasks', 'parent', 'attachment', 'fixVersions'];
  if (acField) { fields.push(acField); }
  const issue = await call('GET', `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${fields.join(',')}`);
  const f = issue.fields || {};
  if (args.includes('--json')) {
    console.log(JSON.stringify({ key: issue.key, fields: f }, null, 2));
    return;
  }
  const who = p => (p && p.displayName) || 'unassigned';
  const lines = [
    `# ${issue.key} - ${f.summary || ''}`,
    '',
    `Source: ${BASE}/browse/${issue.key} (fetched ${new Date().toISOString().slice(0, 16)}Z)`,
    `Type: ${f.issuetype ? f.issuetype.name : '?'} · Status: ${f.status ? f.status.name : '?'} · Priority: ${f.priority ? f.priority.name : '-'} · Assignee: ${who(f.assignee)} · Reporter: ${who(f.reporter)}`,
  ];
  if (f.parent) { lines.push(`Parent: ${f.parent.key} - ${(f.parent.fields && f.parent.fields.summary) || ''}`); }
  if ((f.labels || []).length) { lines.push(`Labels: ${f.labels.join(', ')}`); }
  if ((f.fixVersions || []).length) { lines.push(`Fix versions: ${f.fixVersions.map(v => v.name).join(', ')}`); }
  lines.push('', '## Description', '', adf(f.description) || '(empty)');
  if (acField) { lines.push('', '## Acceptance criteria (field)', '', adf(f[acField]) || '(empty)'); }
  const links = (f.issuelinks || []).map(l => {
    const other = l.outwardIssue || l.inwardIssue;
    const verb = l.outwardIssue ? l.type.outward : l.type.inward;
    return other ? `- ${verb} ${other.key} [${other.fields.status.name}] ${other.fields.summary}` : null;
  }).filter(Boolean);
  if (links.length) { lines.push('', '## Linked issues', '', ...links); }
  const subs = (f.subtasks || []).map(s => `- ${s.key} [${s.fields.status.name}] ${s.fields.summary}`);
  if (subs.length) { lines.push('', '## Sub-tasks', '', ...subs); }
  const files = (f.attachment || []).map(a => `- ${a.filename} (${a.mimeType}, ${a.size} bytes)`);
  if (files.length) { lines.push('', '## Attachments (not downloaded)', '', ...files); }
  const text = `${lines.join('\n')}\n`;
  if (args.includes('--save')) {
    // eslint-disable-next-line global-require
    const run = require('./runs.js').currentRun();
    if (!run || !run.dir) { fail('--save needs an active run (node qc/runs.js current)'); }
    const file = path.join(run.dir, 'ticket.md');
    fs.writeFileSync(file, text);
    console.error(`OK: ticket saved: ${file}`);
  }
  process.stdout.write(text);
}

async function comment() {
  const key = issueKey(1);
  const file = flagValue('--file');
  if (!file || !fs.existsSync(file)) { fail('comment needs --file <path to the report text>'); }
  const body = fs.readFileSync(file, 'utf8');
  // API v2 takes a plain string body (wiki/markdown-ish text); v3 would need ADF.
  const res = await call('POST', `/rest/api/2/issue/${encodeURIComponent(key)}/comment`, { body: { body } });
  console.log(`OK: comment ${res && res.id} posted on ${key}: ${BASE}/browse/${key}?focusedCommentId=${res && res.id}`);
}

async function attach() {
  const key = issueKey(1);
  const files = args.slice(2).filter(a => !a.startsWith('--'));
  if (!files.length) { fail('attach needs one or more file paths'); }
  for (const file of files) {
    if (!fs.existsSync(file)) { fail(`no such file: ${file}`); }
    const boundary = `qc${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
    const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${path.basename(file).replace(/"/g, '')}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([head, fs.readFileSync(file), tail]);
    await call('POST', `/rest/api/3/issue/${encodeURIComponent(key)}/attachments`, {
      body,
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'X-Atlassian-Token': 'no-check' },
    });
    console.log(`OK: attached ${path.basename(file)} to ${key}`);
  }
}

async function labels() {
  const key = issueKey(1);
  const list = v => String(v || '').split(',').map(s => s.trim()).filter(Boolean);
  const ops = [...list(flagValue('--add')).map(l => ({ add: l })), ...list(flagValue('--remove')).map(l => ({ remove: l }))];
  if (!ops.length) { fail('labels needs --add and/or --remove'); }
  await call('PUT', `/rest/api/3/issue/${encodeURIComponent(key)}`, { body: { update: { labels: ops } } });
  console.log(`OK: labels on ${key}: ${ops.map(o => (o.add ? `+${o.add}` : `-${o.remove}`)).join(' ')}`);
}

async function check() {
  const me = await call('GET', '/rest/api/3/myself');
  console.log(`OK: Jira reachable at ${BASE} as ${me.displayName}`);
}

const COMMANDS = { get: getIssue, comment, attach, labels, check };
const cmd = COMMANDS[args[0]];
if (!cmd) { fail(`unknown command "${args[0]}"\n\n${HELP}`); }
// Ticket writes are opt-in (tracker.publish); reads always work.
if (['comment', 'attach', 'labels'].includes(args[0]) && tracker.publish !== true) {
  console.log(`SKIPPED: ${args[0]} on ${args[1] || 'the ticket'} - tracker.publish is false in qc.config.json, nothing was sent to Jira`);
  process.exit(0);
}
cmd().catch(err => fail(`ERROR: ${redact(err && err.message ? err.message : String(err))}`));
