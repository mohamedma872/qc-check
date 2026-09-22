#!/usr/bin/env node
// QC - REST helper for the backend the app under test talks to.
//
// Nothing about any particular backend lives here: base URLs, constant
// headers, the login shape, the health path and the smoke path all come from
// `backend` in qc.config.json. The account comes from the gitignored
// credentials file named by `credentialsFile`. Credentials never appear on the
// command line and never reach the output.
//
// Usage:
//   node runtime/api.js --health                     # probe the gateway 3x, unauthenticated
//   node runtime/api.js --smoke                      # login + GET backend.smokePath
//   node runtime/api.js --token                      # login, print a MASKED token
//   node runtime/api.js GET /api/v1/profile          # authenticated request
//   node runtime/api.js POST /api/v1/things --data '{"name":"x"}'
//   node runtime/api.js --unauth GET '/api/v1/things?page=0&size=1'
//
// Flags:
//   --env <name>     key in backend.baseUrls (default: QC_ENV, then backend.defaultEnv)
//   --data '<json>'  request body for POST/PUT/PATCH
//   --lang <code>    Accept-Language, and substituted for {lang} in backend.headers
//   --raw            print the raw body (compact, for piping)
//   --unauth         skip login (route-existence probes: 401 means the route is deployed)
//   --reveal         with --token only: print the token unmasked (never do this into a report)
//   --timeout <ms>   per-request timeout (default 20000)
//
// Exit codes: 0 ok | 1 usage/config/network | 2 auth failed | 3 gateway down | 4 HTTP >= 400
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const args = process.argv.slice(2);

const HELP = [
  'api.js - config-driven REST helper for the backend under QC.',
  '',
  'Usage:',
  '  api.js --health                          probe backend.healthPath 3x, unauthenticated',
  '  api.js --smoke                           login, then GET backend.smokePath',
  '  api.js --token [--reveal]                login, print the bearer token (masked by default)',
  '  api.js <GET|POST|PUT|PATCH|DELETE> </path> [--data \'<json>\']',
  '',
  'Flags:',
  '  --env <name>      key in backend.baseUrls (default: QC_ENV, then backend.defaultEnv)',
  '  --data \'<json>\'   request body for POST/PUT/PATCH',
  '  --lang <code>     Accept-Language; also replaces {lang} in backend.headers values',
  '  --raw             print the raw response body',
  '  --unauth          skip login (401 on a probe still proves the route is deployed)',
  '  --reveal          print the full token with --token (unsafe for logs and reports)',
  '  --timeout <ms>    per-request timeout, default 20000',
  '  --help            this text',
  '',
  'Config: backend.{baseUrls,healthPath,auth,headers,smokePath} in qc.config.json.',
  'Credentials: the gitignored file named by credentialsFile (never printed).',
  'Exit codes: 0 ok | 1 usage/config/network | 2 auth failed | 3 gateway down | 4 HTTP >= 400',
].join('\n');

// --help must work with no config, no credentials and no network.
if (args.includes('--help') || args.includes('-h')) {
  console.log(HELP);
  process.exit(0);
}
if (!args.length) {
  console.error(HELP);
  process.exit(1);
}

const { loadConfig, loadCredentials } = require('./config.js');

const cfg = loadConfig();
const backend = cfg.backend || {};
const authCfg = backend.auth || {};

if (backend.enabled === false) {
  console.error('backend checks are disabled (backend.enabled = false in qc.config.json)');
  process.exit(1);
}

function flagValue(name) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : null;
}

const BASES = backend.baseUrls || {};
const ENV = flagValue('--env') || process.env.QC_ENV || backend.defaultEnv ||
  Object.keys(BASES).find(k => BASES[k]) || '';
if (!BASES[ENV]) {
  const known = Object.keys(BASES).filter(k => BASES[k]).join(', ') || '(none configured)';
  console.error(`unknown or unconfigured env "${ENV}" - backend.baseUrls has: ${known}`);
  process.exit(1);
}
const BASE = String(BASES[ENV]).replace(/\/+$/, '');
const LANG = flagValue('--lang') || (cfg.project && cfg.project.locales && cfg.project.locales[0]) || 'en';
const TIMEOUT_MS = Number(flagValue('--timeout')) > 0 ? Number(flagValue('--timeout')) : 20000;

// Secrets seen at runtime are scrubbed from everything this script prints, so
// an echoing error body or a verbose gateway can never leak them into a report.
const SECRETS = new Set();
function remember(value) {
  if (typeof value === 'string' && value.length >= 4) { SECRETS.add(value); }
}
function redact(text) {
  let out = String(text);
  for (const s of SECRETS) { out = out.split(s).join('***'); }
  return out;
}
function mask(token) {
  const t = String(token);
  if (t.length <= 12) { return `***(len ${t.length})`; }
  return `${t.slice(0, 6)}...${t.slice(-4)} (len ${t.length})`;
}

// App version for the User-Agent and for {version} in backend.headers. Read
// from the host repo's package.json when there is one; QC must still run in a
// repo that has none.
function repoPackageVersion() {
  let dir = process.cwd();
  for (let i = 0; i < 12; i++) {
    const p = path.join(dir, 'package.json');
    if (fs.existsSync(p)) {
      try { return JSON.parse(fs.readFileSync(p, 'utf8')).version || '0.0.0'; } catch { return '0.0.0'; }
    }
    const up = path.dirname(dir);
    if (up === dir) { break; }
    dir = up;
  }
  return '0.0.0';
}
const APP_VERSION = repoPackageVersion();

// Gateways that demand constant headers (platform, device id, app version,
// a second language header) get them from backend.headers. {lang} and
// {version} are substituted so a per-request value can live in a constant.
function expand(value) {
  return String(value).replace(/\{lang\}/g, LANG).replace(/\{version\}/g, APP_VERSION);
}

function buildHeaders(data, auth) {
  const configured = {};
  for (const [k, v] of Object.entries(backend.headers || {})) { configured[k] = expand(v); }
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': `qc-check-agent/${APP_VERSION}`,
    'Accept-Language': LANG,
    ...configured,
    ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
    ...(auth && auth.token ? { Authorization: `Bearer ${auth.token}` } : {}),
    ...(auth && auth.headers ? auth.headers : {}),
  };
}

function request(method, urlPath, body, auth) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    let url;
    try { url = new URL(BASE + urlPath); } catch { reject(new Error(`bad URL: ${BASE}${urlPath}`)); return; }
    const transport = url.protocol === 'http:' ? http : https;
    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: url.pathname + url.search,
        method,
        timeout: TIMEOUT_MS,
        headers: buildHeaders(data, auth),
      },
      res => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', c => { raw += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw }));
      }
    );
    req.on('timeout', () => req.destroy(new Error(`timeout after ${Math.round(TIMEOUT_MS / 1000)}s`)));
    req.on('error', reject);
    if (data) { req.write(data); }
    req.end();
  });
}

// A login response that hid the token somewhere else must be describable
// without printing it: keys and value types only, never values.
function shapeOf(raw, depth) {
  const d = depth || 0;
  let value = raw;
  // Only the top level is a raw response body; nested strings are values.
  if (d === 0 && typeof raw === 'string') {
    try { value = JSON.parse(raw); } catch { return `<non-json:${raw.length} chars>`; }
  }
  if (value === null) {return 'null';}
  if (Array.isArray(value)) {return d > 3 ? '[...]' : [value.length ? shapeOf(value[0], d + 1) : '<empty>'];}
  if (typeof value === 'object') {
    if (d > 3) {return '{...}';}
    const out = {};
    for (const k of Object.keys(value).slice(0, 40)) {out[k] = shapeOf(value[k], d + 1);}
    return out;
  }
  if (typeof value === 'string') {return `<string:${value.length}>`;}
  return `<${typeof value}>`;
}

function dig(obj, dotPath) {
  return String(dotPath).split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}

function headerValue(headers, name) {
  const v = headers[String(name).toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

// auth.tokenPath is a dot-path into the login response body. Prefix it with
// "headers." for a gateway that returns the token in a response header
// instead (e.g. "headers.x-access-token").
function resolveFromResponse(dotPath, res) {
  if (/^headers\./i.test(dotPath)) {
    return headerValue(res.headers, dotPath.slice('headers.'.length));
  }
  let body = null;
  try { body = JSON.parse(res.raw); } catch { body = null; }
  const fromBody = body ? dig(body, dotPath) : undefined;
  if (fromBody != null && typeof fromBody !== 'object') { return String(fromBody); }
  const fromHeader = headerValue(res.headers, dotPath);
  return fromHeader ? String(fromHeader) : undefined;
}

// Optional: extra per-session headers the gateway hands back at login (device
// fingerprints, CSRF tokens). Map request-header name -> dot-path in the login
// response, same syntax as auth.tokenPath. Absent by default.
function sessionHeaders(res) {
  const out = {};
  for (const [name, dotPath] of Object.entries(authCfg.sessionHeaders || {})) {
    const value = resolveFromResponse(dotPath, res);
    if (value) { out[name] = value; }
  }
  return out;
}

function credentialBlock() {
  let creds;
  try {
    creds = loadCredentials() || {};
  } catch (err) {
    // The loader's message names the file and the config key, never a value.
    console.error(err && err.message ? err.message : String(err));
    process.exit(1);
  }
  const block = creds[ENV] || (creds.username ? creds : null);
  const blocks = Object.keys(creds).filter(k => k !== 'env').join(', ') || '(none)';
  const file = cfg.credentialsFile || 'qc.credentials.js';
  if (!block || !block.username || !block.password) {
    console.error(`no credentials for env "${ENV}" in ${file} - blocks present: ${blocks}`);
    process.exit(1);
  }
  if (block.username === 'CHANGE_ME' || block.password === 'CHANGE_ME') {
    console.error(`${file} still has CHANGE_ME for env "${ENV}" - fill in the QC test account`);
    process.exit(1);
  }
  remember(block.username);
  remember(block.password);
  return block;
}

async function login() {
  const loginPath = authCfg.path;
  const tokenPath = authCfg.tokenPath;
  // Defaulting these would send credentials to a guessed route, so demand them.
  if (!loginPath || !tokenPath) {
    console.error('backend.auth.path and backend.auth.tokenPath must be set in qc.config.json before an authenticated request can be made');
    console.error('  path:      the login route, e.g. "/auth/login"');
    console.error('  tokenPath: dot-path to the bearer token in the login response, e.g. "data.accessToken" (or "headers.x-access-token")');
    process.exit(1);
  }
  const { username, password } = credentialBlock();
  const method = String(authCfg.method || 'POST').toUpperCase();
  const body = {
    ...(authCfg.extraBody || {}),
    [authCfg.usernameField || 'username']: username,
    [authCfg.passwordField || 'password']: password,
  };
  const res = await request(method, loginPath, body, null);
  let token = resolveFromResponse(tokenPath, res);
  if (token) { token = String(token).replace(/^Bearer\s+/i, ''); }
  if (res.status >= 300 || !token) {
    if (res.status < 300) {
      // Login worked, so the body almost certainly holds a token this config
      // failed to locate: describe its shape, never dump it.
      console.error(`AUTHFAIL: login answered HTTP ${res.status} but no token at auth.tokenPath "${tokenPath}".`);
      console.error(`  response body shape: ${JSON.stringify(shapeOf(res.raw))}`);
      console.error(`  response headers:    ${Object.keys(res.headers).join(', ')}`);
      console.error('  fix auth.tokenPath in qc.config.json (prefix it with "headers." for a token returned in a response header)');
    } else {
      console.error(`AUTHFAIL (HTTP ${res.status}) on ${method} ${loginPath}: ${redact(String(res.raw).slice(0, 300))}`);
    }
    process.exit(2);
  }
  remember(token);
  return { token, headers: sessionHeaders(res) };
}

// Any HTTP status < 500 proves the gateway and the service answered; 401 just
// means the auth wall is up, which still counts as alive.
async function healthProbe() {
  try {
    const { status } = await request('GET', backend.healthPath || '/health', null, null);
    return status;
  } catch {
    return 0;
  }
}

function printBody(raw) {
  const text = redact(raw);
  if (args.includes('--raw')) {
    console.log(text);
    return;
  }
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log(text || '(empty body)');
  }
}

(async () => {
  if (args.includes('--health')) {
    let up = false;
    for (let i = 1; i <= 3; i++) {
      const code = await healthProbe();
      console.log(`${ENV} gateway probe ${i}/3: HTTP ${code || 'timeout/unreachable'}`);
      if (code >= 200 && code < 500) { up = true; }
      if (i < 3) { await new Promise(r => setTimeout(r, 3000)); }
    }
    console.log(up ? `OK: ${ENV} gateway is UP` : `STOP: ${ENV} gateway is DOWN - do not boot emulators`);
    process.exit(up ? 0 : 3);
  }

  if (args.includes('--token')) {
    const { token } = await login();
    console.log(args.includes('--reveal') ? token : mask(token));
    return;
  }

  if (args.includes('--smoke')) {
    const smokePath = backend.smokePath || backend.healthPath || '/health';
    const auth = await login();
    const { status, raw } = await request('GET', smokePath, null, auth);
    console.log(`smoke: GET ${smokePath} -> HTTP ${status} (authenticated)`);
    printBody(raw);
    process.exit(status >= 400 ? 4 : 0);
  }

  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      if (['--env', '--data', '--lang', '--timeout'].includes(a)) { i++; }
      continue;
    }
    positional.push(a);
  }
  const method = (positional[0] || '').toUpperCase();
  const urlPath = positional[1];
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) || !urlPath || !urlPath.startsWith('/')) {
    console.error("Usage: api.js [--health|--smoke|--token] | <GET|POST|PUT|PATCH|DELETE> </path> [--data '<json>'] [--unauth] [--raw] [--lang ar] [--env production]");
    process.exit(1);
  }

  const auth = args.includes('--unauth') ? null : await login();
  const { status, raw } = await request(method, urlPath, flagValue('--data'), auth);
  printBody(raw);
  console.error(`HTTP ${status}`);
  if (status >= 400) { process.exit(4); }
})().catch(err => {
  console.error('ERROR:', redact(err && err.message ? err.message : String(err)));
  process.exit(1);
});
