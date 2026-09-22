#!/usr/bin/env node
// QC - REST helper for the backend the app under test talks to.
//
// Nothing about any particular backend lives here: base URLs, constant
// headers, the login shape, the health path and the smoke path all come from
// `backend` in qc.config.json. The account for the environment comes from
// QC_CRED_<ENV>_USERNAME/_PASSWORD or the gitignored credentials file
// (config.credentialsFor). Credentials never appear on the command line and
// never reach the output or a saved file.
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
//   --save <name>    also write the response, redacted, to the run's api/ folder
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
  '  --save <name>     with GET/POST/PUT/PATCH/DELETE, --smoke or --health: write the',
  '                    response to the run\'s api/ folder (001-<name>.json) as',
  '                    { request: { method, path, env }, status, headers, body },',
  '                    with the token, credentials and session headers masked.',
  '                    Request bodies and login responses are never saved.',
  '  --help            this text',
  '',
  'Config: backend.{baseUrls,healthPath,auth,headers,smokePath} in qc.config.json.',
  'Credentials: QC_CRED_<ENV>_USERNAME/_PASSWORD, else the gitignored file named by',
  'credentialsFile (set with `qc-check env credentials <env>`; never printed).',
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

const { loadConfig, credentialsFor } = require('./config.js');

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
  if (typeof value === 'string' && value.length >= 4) {
    SECRETS.add(value);
    // The JSON-escaped form too: a value with a quote or backslash appears
    // escaped inside a response body or a saved file.
    const escaped = JSON.stringify(value).slice(1, -1);
    if (escaped !== value) { SECRETS.add(escaped); }
  }
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
    // --env flows through here too: the account belongs to the environment
    // the request goes to, never to whatever QC_ENV happens to say.
    creds = credentialsFor(ENV);
  } catch (err) {
    // config.js names the setup command and the env vars, never a value.
    console.error(err && err.message ? err.message : String(err));
    process.exit(1);
  }
  remember(creds.username);
  remember(creds.password);
  return creds;
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
  const extra = sessionHeaders(res);
  for (const v of Object.values(extra)) { remember(String(v)); }
  return { token, headers: extra };
}

// Classify one probe. A status below 500 is only proof of life when the API
// itself produced it. An edge proxy or firewall that refuses the connection
// (typically a VPN-only environment reached without the VPN) answers 403 with
// its own HTML page, and counting that as UP would wave the run through the
// one gate meant to stop it.
async function healthProbe() {
  try {
    const { status, headers, raw } = await request('GET', backend.healthPath || '/health', null, null);
    lastProbe = { status, headers, raw };
    const type = String((headers && headers['content-type']) || '').toLowerCase();
    const html = type.includes('text/html') || /^\s*<(!doctype|html)/i.test(String(raw || ''));
    let verdict;
    if (status >= 200 && status < 300) verdict = 'up';
    else if (status === 401) verdict = 'up'; // the auth wall answering is still the API
    else if (status >= 300 && status < 500) verdict = html ? 'blocked' : 'up';
    else verdict = 'down';
    return { status, verdict };
  } catch {
    lastProbe = null;
    return { status: 0, verdict: 'down' };
  }
}
let lastProbe = null;

// --- --save --------------------------------------------------------------------

const SAVE_NAME = flagValue('--save');
if (args.includes('--save') && (!SAVE_NAME || SAVE_NAME.startsWith('--'))) {
  console.error('--save needs a name, e.g. --save profile-get');
  process.exit(1);
}

// Header names whose values authenticate a caller. Their values are dropped
// from a saved file whatever the gateway sends back.
const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-access-token|x-refresh-token|x-csrf-token|x-xsrf-token)$/i;
// Body keys that commonly carry a secret, masked even when this run never saw
// the value (a refresh token, a second session id).
const SENSITIVE_KEY = /(pass(word)?|secret|token|authorization|cookie|api[-_]?key|otp)/i;

function sensitiveHeaderNames() {
  const names = new Set(Object.keys(authCfg.sessionHeaders || {}).map(n => n.toLowerCase()));
  const all = [authCfg.tokenPath, ...Object.values(authCfg.sessionHeaders || {})];
  for (const p of all) {
    if (typeof p === 'string' && /^headers\./i.test(p)) { names.add(p.slice('headers.'.length).toLowerCase()); }
  }
  return names;
}

function maskKeys(value, depth) {
  const d = depth || 0;
  if (d > 20 || value === null || typeof value !== 'object') { return value; }
  if (Array.isArray(value)) { return value.map(v => maskKeys(v, d + 1)); }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEY.test(k) && v !== null && typeof v !== 'object' ? '***' : maskKeys(v, d + 1);
  }
  return out;
}

function pathOnly(p) {
  return String(p || '').split('?')[0].replace(/\/+$/, '');
}

// Writes { request, status, headers, body } to the run's api/ folder. Only the
// method, path and environment of the request are recorded, never its body,
// so a credential sent in a request can never end up on disk. A failure to
// save warns and leaves the exit code alone.
function saveResponse(method, urlPath, res, extra) {
  if (!SAVE_NAME || !res) { return; }
  if (authCfg.path && pathOnly(urlPath) === pathOnly(authCfg.path)) {
    console.error('WARN: not saving a login response (it carries the session token). Nothing written.');
    return;
  }
  try {
    const drop = sensitiveHeaderNames();
    const headers = {};
    for (const [k, v] of Object.entries(res.headers || {})) {
      headers[k] = SENSITIVE_HEADER.test(k) || drop.has(k.toLowerCase()) ? '***' : v;
    }
    const text = redact(res.raw == null ? '' : res.raw);
    let body;
    try { body = maskKeys(JSON.parse(text)); } catch { body = text; }
    const record = {
      request: { method, path: redact(urlPath), env: ENV },
      status: res.status,
      headers,
      body,
      ...(extra || {}),
    };
    // Last pass over the serialised file: nothing this run learned may survive.
    const out = `${redact(JSON.stringify(record, null, 2))}\n`;
    // eslint-disable-next-line global-require
    const file = require('./runs.js').artifactPath('api', SAVE_NAME, 'json');
    fs.writeFileSync(file, out);
    console.error(`OK: response saved: ${file}`);
  } catch (err) {
    console.error(`WARN: response not saved: ${redact(err && err.message ? err.message : String(err))}`);
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
    let blocked = false;
    const probes = [];
    for (let i = 1; i <= 3; i++) {
      const { status, verdict } = await healthProbe();
      probes.push({ status, verdict });
      const note = verdict === 'blocked' ? ' (HTML from an edge proxy, not the API)' : '';
      console.log(`${ENV} gateway probe ${i}/3: HTTP ${status || 'timeout/unreachable'}${note}`);
      if (verdict === 'up') { up = true; }
      if (verdict === 'blocked') { blocked = true; }
      if (i < 3) { await new Promise(r => setTimeout(r, 3000)); }
    }
    const healthPath = backend.healthPath || '/health';
    const verdict = up ? 'UP' : blocked ? 'BLOCKED' : 'DOWN';
    saveResponse('GET', healthPath, lastProbe || { status: 0, headers: {}, raw: '' }, { verdict, probes });
    if (up) {
      console.log(`OK: ${ENV} gateway is UP`);
      process.exit(0);
    }
    if (blocked) {
      console.log(`STOP: ${ENV} gateway is BLOCKED - an edge proxy refused the request before it reached the API.`);
      console.log('   If this environment is VPN-only, connect the VPN and re-run. Do not boot emulators.');
    } else {
      console.log(`STOP: ${ENV} gateway is DOWN - do not boot emulators`);
    }
    process.exit(3);
  }

  if (args.includes('--token')) {
    const { token } = await login();
    console.log(args.includes('--reveal') ? token : mask(token));
    return;
  }

  if (args.includes('--smoke')) {
    const smokePath = backend.smokePath || backend.healthPath || '/health';
    const auth = await login();
    const res = await request('GET', smokePath, null, auth);
    const { status, raw } = res;
    console.log(`smoke: GET ${smokePath} -> HTTP ${status} (authenticated)`);
    printBody(raw);
    saveResponse('GET', smokePath, res);
    process.exit(status >= 400 ? 4 : 0);
  }

  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      if (['--env', '--data', '--lang', '--timeout', '--save'].includes(a)) { i++; }
      continue;
    }
    positional.push(a);
  }
  const method = (positional[0] || '').toUpperCase();
  const urlPath = positional[1];
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) || !urlPath || !urlPath.startsWith('/')) {
    console.error("Usage: api.js [--health|--smoke|--token] | <GET|POST|PUT|PATCH|DELETE> </path> [--data '<json>'] [--unauth] [--raw] [--lang ar] [--env production] [--save <name>]");
    process.exit(1);
  }

  const auth = args.includes('--unauth') ? null : await login();
  const res = await request(method, urlPath, flagValue('--data'), auth);
  const { status, raw } = res;
  printBody(raw);
  saveResponse(method, urlPath, res);
  console.error(`HTTP ${status}`);
  if (status >= 400) { process.exit(4); }
})().catch(err => {
  console.error('ERROR:', redact(err && err.message ? err.message : String(err)));
  process.exit(1);
});
