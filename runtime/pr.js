#!/usr/bin/env node
// QC - pull request intake and review comments, for GitHub and Bitbucket Cloud.
//
// The host comes from repo.host in qc.config.json, or is detected from the git
// remote (repo.remote, default origin). The owner/workspace and repository are
// always parsed from that remote.
//   GitHub     the gh CLI, logged in (`gh auth status`).
//   Bitbucket  the Bitbucket Cloud REST API with basic auth from the env vars
//              named by repo.bitbucket.emailEnv / tokenEnv (defaults
//              BITBUCKET_EMAIL, BITBUCKET_API_TOKEN). Values are never printed.
//
// Usage:
//   node qc/pr.js get <n> [--json] [--save]     the PR as a ticket (--save: <run>/ticket.md)
//   node qc/pr.js id <n> [--json]               the ticket id to use for this PR
//   node qc/pr.js comment <n> --file <path> [--dry-run]
//   node qc/pr.js comment <n> --update <commentId> --file <path> [--dry-run]
//   node qc/pr.js approve <n> [--dry-run]       approve the PR as the authenticated user
//   node qc/pr.js unapprove <n> [--dry-run]     withdraw that approval (Bitbucket only)
//
// Exit codes: 0 ok | 1 usage/config | 2 auth failed | 3 not found | 4 other HTTP error
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFileSync, spawnSync } = require('child_process');

const host = require('./repo-host.js');

const HELP = [
  'pr.js - pull request intake and review comments (GitHub via gh, Bitbucket Cloud via REST).',
  '',
  'Usage:',
  '  pr.js get <n> [--json] [--save]        the PR as a ticket; --save writes <run>/ticket.md',
  '                                         (<run>/pr.md when a tracker ticket.md is already there)',
  '  pr.js id <n> [--json]                  the ticket id for this PR: a key from the title or',
  '                                         branch (tracker.ticketPattern), else PR-<n>',
  '  pr.js comment <n> --file <path> [--dry-run]',
  '  pr.js comment <n> --update <commentId> --file <path> [--dry-run]',
  '                                         post (or edit) a review comment; --dry-run prints',
  '                                         what would be sent and where, and writes nothing',
  '  pr.js approve <n> [--dry-run]          approve the PR as the authenticated user (OPEN PRs only;',
  '                                         already approved reads as OK). --dry-run reads the PR,',
  '                                         prints the call it would make, and writes nothing',
  '  pr.js unapprove <n> [--dry-run]        withdraw that approval. Bitbucket only: GitHub has no',
  '                                         unapprove, dismiss the review instead.',
  '                                         Both are skipped (exit 0) when QC_EVAL=1.',
  '',
  'Options:',
  '  --remote <name>   the git remote to read (default repo.remote, else origin)',
  '',
  'Host: repo.host (github | bitbucket | none), detected from the remote when empty.',
  'Bitbucket auth: the env vars named by repo.bitbucket.emailEnv / tokenEnv',
  '(defaults BITBUCKET_EMAIL, BITBUCKET_API_TOKEN). Values are never printed.',
  'Exit codes: 0 ok | 1 usage/config | 2 auth failed | 3 not found | 4 other HTTP error',
].join('\n');

let SECRET = null;

function redact(text) {
  const s = String(text);
  return SECRET ? s.split(SECRET).join('***') : s;
}

function fail(message, code) {
  console.error(redact(message));
  process.exit(code || 1);
}

function flagValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined && !String(args[i + 1]).startsWith('--') ? args[i + 1] : null;
}

function prNumber(args) {
  const raw = String(args[1] || '').replace(/^#/, '');
  if (!/^\d+$/.test(raw)) {fail(`ERROR: "${args[1] || ''}" is not a pull request number\n\n${HELP}`);}
  return Number(raw);
}

// --- context: config, remote, host -------------------------------------------

function context(args) {
  // eslint-disable-next-line global-require
  const { loadConfigOptional } = require('./config.js');
  const cfg = loadConfigOptional();
  const repo = cfg.repo || {};
  const remoteName = flagValue(args, '--remote') || repo.remote || 'origin';
  let url = '';
  try {
    url = execFileSync('git', ['remote', 'get-url', remoteName], {
      cwd: cfg.repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (_) {
    fail(`ERROR: no git remote "${remoteName}" in ${cfg.repoRoot} (set repo.remote, or pass --remote <name>)`);
  }
  const remote = host.parseRemote(url);
  let kind;
  try {
    kind = host.resolveHost(repo.host, remote).kind;
  } catch (err) {
    fail(`ERROR: ${err.message}`);
  }
  if (kind !== 'none' && !remote) {
    fail(`ERROR: cannot read owner/repo from the "${remoteName}" remote (${url})`);
  }
  if (kind === 'none') {
    fail(
      `ERROR: no supported PR host for the "${remoteName}" remote (${remote ? remote.hostname : url || 'none'}). ` +
        'pr.js supports GitHub and Bitbucket Cloud; set repo.host to github or bitbucket if detection is wrong.',
    );
  }
  return { cfg, remote, kind, remoteName };
}

// --- GitHub --------------------------------------------------------------------

function ghRepoArg(remote) {
  return remote.hostname === 'github.com' ? remote.slug : `${remote.hostname}/${remote.slug}`;
}

function gh(argv, opts) {
  const res = spawnSync('gh', argv, { encoding: 'utf8', ...(opts || {}) });
  if (res.error && res.error.code === 'ENOENT') {
    fail('ERROR: the gh CLI is not on PATH. Install it (brew install gh) and run `gh auth login`.');
  }
  if (res.status !== 0) {
    const why = String(res.stderr || res.stdout || '').trim();
    if (/not found|Could not resolve to a PullRequest|no pull requests found/i.test(why)) {fail(`NOT FOUND: ${why}`, 3);}
    if (/auth|401|403|login/i.test(why)) {fail(`AUTHFAIL: ${why} (run \`gh auth status\`)`, 2);}
    fail(`ERROR: gh ${argv.slice(0, 2).join(' ')} failed: ${why}`, 4);
  }
  return res.stdout;
}

function githubPr(remote, n) {
  const fields = 'number,title,body,headRefName,baseRefName,headRefOid,author,url,state';
  const out = gh(['pr', 'view', String(n), '-R', ghRepoArg(remote), '--json', fields]);
  return host.fromGithub(JSON.parse(out));
}

// --- Bitbucket Cloud ---------------------------------------------------------

function bitbucketAuth(cfg) {
  const bb = (cfg.repo && cfg.repo.bitbucket) || {};
  const names = { email: bb.emailEnv || 'BITBUCKET_EMAIL', token: bb.tokenEnv || 'BITBUCKET_API_TOKEN' };
  const missing = Object.values(names).filter(n => !process.env[n]);
  if (missing.length) {
    fail(`ERROR: Bitbucket credentials are not in the environment: set ${missing.join(', ')} (an Atlassian API token with pull request scope)`);
  }
  SECRET = process.env[names.token];
  return { names, header: `Basic ${Buffer.from(`${process.env[names.email]}:${SECRET}`).toString('base64')}` };
}

function bitbucketRequest(auth, method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = https.request(
      {
        hostname: host.BITBUCKET_API.hostname,
        path: apiPath,
        method,
        timeout: 30000,
        headers: {
          Authorization: auth.header,
          Accept: 'application/json',
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
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
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout after 30s')));
    req.on('error', reject);
    if (data) {req.write(data);}
    req.end();
  });
}

async function bitbucketCall(auth, method, apiPath, body) {
  return bitbucketCheck(auth, method, apiPath, await bitbucketRequest(auth, method, apiPath, body));
}

// Exits on an auth, not-found or other HTTP error; otherwise the parsed body.
function bitbucketCheck(auth, method, apiPath, res) {
  if (res.status === 401 || res.status === 403) {
    fail(`AUTHFAIL (HTTP ${res.status}) on ${method} ${apiPath}: check ${auth.names.email} / ${auth.names.token}`, 2);
  }
  if (res.status === 404) {fail(`NOT FOUND (HTTP 404) on ${method} ${apiPath}`, 3);}
  if (res.status >= 400) {
    const why = res.json && res.json.error ? JSON.stringify(res.json.error) : res.raw.slice(0, 300);
    fail(`ERROR: HTTP ${res.status} on ${method} ${apiPath}: ${why}`, 4);
  }
  return res.json;
}

function bitbucketPath(remote, rest) {
  return `${host.BITBUCKET_API.basePath}/repositories/${encodeURIComponent(remote.owner)}/${encodeURIComponent(remote.repo)}${rest}`;
}

async function bitbucketPr(cfg, remote, n) {
  const auth = bitbucketAuth(cfg);
  const j = await bitbucketCall(auth, 'GET', bitbucketPath(remote, `/pullrequests/${n}`));
  return host.fromBitbucket(j);
}

// --- commands ----------------------------------------------------------------

async function fetchPr(ctx, n) {
  return ctx.kind === 'github' ? githubPr(ctx.remote, n) : bitbucketPr(ctx.cfg, ctx.remote, n);
}

function ticketIdFor(ctx, pr) {
  const pattern = (ctx.cfg.tracker && ctx.cfg.tracker.ticketPattern) || '[A-Z]+-[0-9]+';
  return host.deriveTicketId(pr, pattern);
}

async function cmdGet(args) {
  const ctx = context(args);
  const n = prNumber(args);
  const pr = await fetchPr(ctx, n);
  const derived = ticketIdFor(ctx, pr);
  if (args.includes('--json')) {
    console.log(JSON.stringify({ ...pr, ticketId: derived.id, ticketSource: derived.source }, null, 2));
    return;
  }
  const text = host.renderTicket(pr, derived.id || `PR-${pr.number}`);
  if (args.includes('--save')) {
    // eslint-disable-next-line global-require
    const run = require('./runs.js').currentRun();
    if (!run || !run.dir) {fail('ERROR: --save needs an active run (node qc/runs.js current)');}
    let file = path.join(run.dir, 'ticket.md');
    // A tracker ticket fetched for the same run stays the ticket; the PR is
    // then extra context beside it.
    if (fs.existsSync(file) && !fs.readFileSync(file, 'utf8').includes('Type: Pull request')) {
      file = path.join(run.dir, 'pr.md');
      console.error('WARN: ticket.md already holds the tracker ticket; the PR is saved beside it as pr.md');
    }
    fs.writeFileSync(file, text);
    console.error(`OK: PR #${n} saved: ${file}`);
  }
  process.stdout.write(text);
}

async function cmdId(args) {
  const ctx = context(args);
  const n = prNumber(args);
  const pr = await fetchPr(ctx, n);
  const derived = ticketIdFor(ctx, pr);
  if (args.includes('--json')) {
    console.log(JSON.stringify({ id: derived.id, source: derived.source, reason: derived.reason || '', pr }, null, 2));
    if (!derived.id) {process.exit(1);}
    return;
  }
  if (!derived.id) {fail(`ERROR: ${derived.reason}`);}
  const why = {
    title: 'ticket key found in the PR title',
    branch: `ticket key found in the source branch ${pr.sourceBranch}`,
    pseudo: 'no ticket key in the PR title or branch: using the pseudo-id',
  }[derived.source];
  console.error(`OK: ${why}`);
  console.log(derived.id);
}

async function cmdComment(args) {
  const n = prNumber(args);
  const file = flagValue(args, '--file');
  const updateId = flagValue(args, '--update');
  const dryRun = args.includes('--dry-run');
  if (args.includes('--update') && !updateId) {fail('ERROR: --update needs the id of the comment to edit');}
  if (updateId && !/^\d+$/.test(updateId)) {fail(`ERROR: "${updateId}" is not a comment id`);}
  if (!file || !fs.existsSync(file)) {fail('ERROR: comment needs --file <path to the comment text>');}
  const body = fs.readFileSync(file, 'utf8');
  if (!body.trim()) {fail(`ERROR: ${file} is empty`);}
  const ctx = context(args);
  const plan = host.planComment({ kind: ctx.kind, remote: ctx.remote, number: n, body, updateId });

  if (dryRun) {
    const lines = body.split('\n');
    console.log(`DRY RUN: would ${plan.action} a comment on ${ctx.kind} ${plan.where}`);
    if (plan.method) {console.log(`  request  ${plan.method} ${plan.hostname}${plan.path}  {"content":{"raw": <${body.length} chars>}}`);}
    else {console.log(`  command  ${plan.command.join(' ')}`);}
    console.log(`  body     ${body.length} chars, ${lines.length} lines, from ${file}`);
    for (const l of lines.slice(0, 8)) {console.log(`  | ${l}`);}
    if (lines.length > 8) {console.log(`  | ... (${lines.length - 8} more lines)`);}
    console.log('OK: nothing was sent (--dry-run)');
    return;
  }

  if (ctx.kind === 'github') {
    if (updateId) {
      const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qc-pr-')), 'body.json');
      fs.writeFileSync(tmp, JSON.stringify({ body }));
      const out = gh(['api', '--method', 'PATCH', `repos/${ctx.remote.slug}/issues/comments/${updateId}`, '--hostname', ctx.remote.hostname, '--input', tmp]);
      fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
      let url = '';
      try { url = JSON.parse(out).html_url || ''; } catch (_) { url = ''; }
      console.log(`OK: comment ${updateId} updated on ${plan.where}${url ? `: ${url}` : ''}`);
      return;
    }
    const out = gh(['pr', 'comment', String(n), '-R', plan.repoArg, '--body-file', file]);
    console.log(`OK: comment posted on ${plan.where}: ${out.trim()}`);
    return;
  }

  const auth = bitbucketAuth(ctx.cfg);
  const res = await bitbucketCall(auth, plan.method, plan.path, plan.payload);
  const link = res && res.links && res.links.html && res.links.html.href;
  console.log(`OK: comment ${res && res.id} ${updateId ? 'updated' : 'posted'} on ${plan.where}${link ? `: ${link}` : ''}`);
}

// Approve (or withdraw an approval) as the authenticated user. An external
// write: the workflow runs --dry-run first and approves only a PASS run.
async function cmdApprove(args, remove) {
  const verb = remove ? 'unapprove' : 'approve';
  const n = prNumber(args);
  const dryRun = args.includes('--dry-run');
  if (process.env.QC_EVAL === '1') {
    console.log(`OK: ${verb} PR #${n} skipped: eval mode (QC_EVAL=1), nothing was sent`);
    return;
  }
  const ctx = context(args);
  const repoArg = ctx.kind === 'github' ? ghRepoArg(ctx.remote) : ctx.remote.slug;
  const where = `${repoArg} PR #${n}`;
  if (remove && ctx.kind === 'github') {
    fail(
      `WARN: GitHub has no unapprove for ${where}. Dismiss the approving review instead ` +
        `(gh api --method PUT repos/${ctx.remote.slug}/pulls/${n}/reviews/<reviewId>/dismissals -f message=...), ` +
        'or leave a new review requesting changes.',
    );
  }

  // Read first: only an open PR can be approved, and the dry run should show that refusal too.
  const pr = await fetchPr(ctx, n);
  const state = String(pr.state || '').toUpperCase();
  if (state !== 'OPEN') {fail(`ERROR: ${where} is ${state || 'in an unknown state'}, not OPEN: refusing to ${verb}`);}

  const apiPath = bitbucketPath(ctx.remote, `/pullrequests/${n}/approve`);
  const method = remove ? 'DELETE' : 'POST';
  const command = ['gh', 'pr', 'review', String(n), '-R', repoArg, '--approve'];

  if (dryRun) {
    console.log(`DRY RUN: would ${verb} ${ctx.kind} ${where} (${state}): ${pr.title}`);
    if (ctx.kind === 'github') {console.log(`  command  ${command.join(' ')}`);}
    else {console.log(`  request  ${method} ${host.BITBUCKET_API.hostname}${apiPath}`);}
    console.log('OK: nothing was sent (--dry-run)');
    return;
  }

  if (ctx.kind === 'github') {
    gh(command.slice(1));
    console.log(`OK: approved ${where}${pr.url ? `: ${pr.url}` : ''}`);
    return;
  }

  const auth = bitbucketAuth(ctx.cfg);
  const res = await bitbucketRequest(auth, method, apiPath);
  // Bitbucket answers 409 to a second approval, and 404 to withdrawing one that
  // is not there (the PR itself was just read, so 404 is the approval).
  if (!remove && res.status === 409) {
    console.log(`OK: ${where} was already approved by this user; nothing changed${pr.url ? `: ${pr.url}` : ''}`);
    return;
  }
  if (remove && res.status === 404) {
    console.log(`OK: ${where} had no approval from this user to withdraw; nothing changed`);
    return;
  }
  const j = bitbucketCheck(auth, method, apiPath, res);
  const who = j && j.user && j.user.display_name ? ` as ${j.user.display_name}` : '';
  console.log(`OK: ${remove ? 'approval withdrawn on' : 'approved'} ${where}${who}${pr.url ? `: ${pr.url}` : ''}`);
}

const COMMANDS = {
  get: cmdGet,
  id: cmdId,
  comment: cmdComment,
  approve: args => cmdApprove(args, false),
  unapprove: args => cmdApprove(args, true),
};

function main(args) {
  if (!args.length || args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    process.exit(args.length ? 0 : 1);
  }
  const cmd = COMMANDS[args[0]];
  if (!cmd) {fail(`ERROR: unknown command "${args[0]}"\n\n${HELP}`);}
  cmd(args).catch(err => fail(`ERROR: ${err && err.message ? err.message : String(err)}`));
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { main };
