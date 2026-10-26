#!/usr/bin/env node
'use strict';

// Checks for the review-driven workflow: body redaction in api.js --save and
// the code-review phase in state.js. No device, no agent, no network.
//
//   node test/review.js

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const STATE = path.join(ROOT, 'runtime', 'state.js');

let failures = 0;
let checks = 0;

function check(name, fn) {
  checks += 1;
  try {
    fn();
    process.stdout.write(`  ok    ${name}\n`);
  } catch (err) {
    failures += 1;
    process.stdout.write(`  FAIL  ${name}\n        ${String(err.message).split('\n')[0]}\n`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ------------------------------------------------------------ redaction

const { redactBody, keyClass, looksSecret, maskValue } = require(path.join(ROOT, 'runtime', 'api.js'));

// Made-up values shaped like the real leak: a config endpoint returning
// { key, value } entries, plus top-level apiKey and siteKey.
const HEX32 = '0123456789abcdef0123456789abcdef';
const HEX16 = 'fedcba9876543210';
const SITEKEY = '6LeAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const MAPSKEY = 'AIzaSyA0000000000000000000000000000000';
const fixture = {
  apiKey: 'sk_test_0000000000000000000000',
  siteKey: SITEKEY,
  appConfigs: {
    entry: [
      { key: 'example.vendor.en.api.key', value: HEX32 },
      { key: 'example.vendor.search.site.key', value: 'ss-example-en-dev0000000000000' },
      { key: 'example.recs.api.client.key', value: HEX16 },
      { key: 'example.commerce.client.secret', value: 'secret' },
      { key: 'example.reviews.bearer.token', value: HEX32 + HEX16 },
      { key: 'example.maps.key', value: MAPSKEY },
      { key: 'example.social.login.client.id', value: '0000000000000000' },
      // not secrets: these must survive untouched
      { key: 'category.page.title', value: 'Shop by category' },
      { key: 'example.social.login.base.url', value: 'https://example.com/oauth2/auth' },
      { key: 'example.express.delivery.cutOffTime', value: '20:00' },
      { key: 'otpLength', value: '4' },
      { key: 'example.order.code.regex', value: '^[a-zA-Z0-9]+$' },
      { key: 'feature.registration.otp.enabled', value: 'true' },
      { key: 'example.commerce.client.id', value: 'example_client' },
      { key: 'example.no.value' },
      { name: 'Secret Santa', value: 'gift wrap' },
    ],
  },
  nested: {
    deeper: [{ clientSecret: 'cs_live_0000000000000000', passwordMinLength: 8, tokenExpiresIn: 3600 }],
    i18n: { key: 'checkout.button.pay', sortKey: 'price-asc' },
    session: { accessToken: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl' },
  },
  isPasswordSet: false,
  title: 'Products',
  count: 42,
};

function flat(obj) {
  return JSON.stringify(obj);
}

check('maskValue keeps a 4-character prefix and the length', () => {
  assert(maskValue(HEX32) === '0123…(32)', `got ${maskValue(HEX32)}`);
  assert(maskValue('secret') === '…(6)', `short values show no prefix, got ${maskValue('secret')}`);
});

check('looksSecret: opaque credentials yes, dotted names and words no', () => {
  for (const v of [HEX32, HEX16, SITEKEY, MAPSKEY]) assert(looksSecret(v), `${v.slice(0, 6)}... should look secret`);
  for (const v of ['category.page.title', 'example.vendor.en.api.key', 'Shop by category', 'https://example.com/0123456789abcdef0123', 'price-asc', 'short1']) {
    assert(!looksSecret(v), `"${v}" should not look secret`);
  }
});

check('keyClass: strong, weak and plain names', () => {
  for (const k of ['apiKey', 'api_key', 'API-KEY', 'siteKey', 'clientSecret', 'password', 'accessToken', 'otp']) {
    assert(keyClass(k) === 'strong', `${k} should be strong`);
  }
  for (const k of ['key', 'sortKey', 'clientId']) assert(keyClass(k) === 'weak', `${k} should be weak`);
  for (const k of ['title', 'tokenType', 'pageNumber', 'value', 'keyboardType']) {
    assert(keyClass(k) === null, `${k} should be plain`);
  }
});

const { body, masked } = redactBody(fixture);

check('top-level apiKey and siteKey are masked with a prefix', () => {
  assert(body.apiKey === 'sk_t…(30)', `apiKey: ${body.apiKey}`);
  assert(body.siteKey === '6LeA…(40)', `siteKey: ${body.siteKey}`);
});

check('{key, value} entries named like a secret have their value masked', () => {
  const byKey = Object.fromEntries(body.appConfigs.entry.map(e => [e.key || e.name, e.value]));
  assert(byKey['example.vendor.en.api.key'] === '0123…(32)', 'api.key entry not masked');
  assert(/…\(\d+\)$/.test(byKey['example.vendor.search.site.key']), 'site.key entry not masked');
  assert(/…\(16\)$/.test(byKey['example.recs.api.client.key']), 'client.key entry not masked');
  assert(byKey['example.commerce.client.secret'] === '…(6)', 'client.secret entry not masked');
  assert(/…\(48\)$/.test(byKey['example.reviews.bearer.token']), 'bearer.token entry not masked');
  assert(/…\(38\)$/.test(byKey['example.maps.key']), 'maps.key entry not masked');
  assert(/…\(16\)$/.test(byKey['example.social.login.client.id']), 'an opaque client id was not masked');
});

check('nested secrets and JWTs are masked, numbers and flags kept', () => {
  const d = body.nested.deeper[0];
  assert(/^cs_l…\(\d+\)$/.test(d.clientSecret), `clientSecret: ${d.clientSecret}`);
  assert(d.passwordMinLength === 8, 'a password policy number was masked');
  assert(d.tokenExpiresIn === 3600, 'a token lifetime was masked');
  assert(/^eyJh…\(\d+\)$/.test(body.nested.session.accessToken), 'accessToken not masked');
  assert(body.isPasswordSet === false, 'a boolean flag was masked');
});

check('no secret value survives anywhere in the redacted body', () => {
  const out = flat(body);
  for (const secret of [HEX32, HEX16, SITEKEY, MAPSKEY, 'sk_test_0000000000000000000000', 'cs_live_0000000000000000', 'eyJhbGciOiJIUzI1NiJ9']) {
    assert(!out.includes(secret), `a secret survived: ${secret.slice(0, 4)}...`);
  }
});

check('non-secret values survive untouched (negative case)', () => {
  const byKey = Object.fromEntries(body.appConfigs.entry.map(e => [e.key || e.name, e.value]));
  assert(byKey['category.page.title'] === 'Shop by category', 'an i18n title was masked');
  assert(byKey['example.social.login.base.url'] === 'https://example.com/oauth2/auth', 'a URL was masked');
  assert(byKey['example.express.delivery.cutOffTime'] === '20:00', 'a time was masked');
  assert(byKey.otpLength === '4', 'otpLength was masked');
  assert(byKey['example.order.code.regex'] === '^[a-zA-Z0-9]+$', 'a regex was masked');
  assert(byKey['feature.registration.otp.enabled'] === 'true', 'a feature flag was masked');
  assert(byKey['example.commerce.client.id'] === 'example_client', 'a readable client id was masked');
  assert(byKey['Secret Santa'] === 'gift wrap', 'a label with spaces was treated as a config key');
  // the key names themselves are evidence and must stay readable
  assert(body.appConfigs.entry[0].key === 'example.vendor.en.api.key', 'an entry key name was masked');
  assert(body.nested.i18n.key === 'checkout.button.pay', 'an i18n "key" was masked');
  assert(body.nested.i18n.sortKey === 'price-asc', 'a sort key was masked');
  assert(body.title === 'Products' && body.count === 42, 'plain fields changed');
  assert(!('value' in body.appConfigs.entry.find(e => e.key === 'example.no.value')), 'an entry without value grew one');
});

check('masked lists key names only, never values', () => {
  assert(masked.includes('apiKey') && masked.includes('example.vendor.en.api.key'), `masked: ${masked.join(', ')}`);
  assert(!flat(masked).includes(HEX32), 'a value reached the masked list');
});

check('backend.redactKeys extends the pattern', () => {
  const input = { merchantRef: 'plain-but-private', entry: [{ key: 'example.merchant.ref', value: 'abc' }] };
  const plain = redactBody(input).body;
  assert(plain.merchantRef === 'plain-but-private', 'merchantRef masked without config');
  const extended = redactBody(input, ['merchant_ref']).body;
  assert(extended.merchantRef === 'plai…(17)', `merchantRef: ${extended.merchantRef}`);
  assert(extended.entry[0].value === '…(3)', 'an entry named by redactKeys was not masked');
  const bad = redactBody(input, 'not-an-array').body;
  assert(bad.merchantRef === 'plain-but-private', 'a non-array redactKeys should add nothing');
});

check('api.js still runs as a CLI after being required', () => {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'runtime', 'api.js'), '--help'], { encoding: 'utf8' });
  assert(/redactKeys/.test(out), '--help does not mention backend.redactKeys');
});

// ------------------------------------------------------------ state.js

// A throwaway repo with the smallest config state.js accepts.
const host = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-review-'));
fs.writeFileSync(path.join(host, 'qc.config.json'), JSON.stringify({
  project: { name: 'Example', reportsDir: 'qc-reports' },
  tracker: { kind: 'none', ticketPattern: '[A-Z]+-[0-9]+' },
  backend: { enabled: false, defaultEnv: 'staging' },
}, null, 2));

const childEnv = { ...process.env };
delete childEnv.QC_RUN_DIR;
delete childEnv.QC_ENV;

function state(args, ticket = 'ABC-123') {
  try {
    const out = execFileSync(process.execPath, [STATE, ticket, ...args], {
      cwd: host, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: childEnv,
    });
    return { status: 0, out };
  } catch (err) {
    return { status: err.status === undefined ? 1 : err.status, out: `${err.stdout || ''}${err.stderr || ''}` };
  }
}

function stateJson(ticket = 'ABC-123') {
  const r = state(['get', '--json'], ticket);
  assert(r.status === 0, `get --json exited ${r.status}: ${r.out.slice(0, 160)}`);
  return JSON.parse(r.out.slice(0, r.out.lastIndexOf('\n-> resume at:')));
}

try {
  check('state.js lists code-review between ticket and test-plan', () => {
    const r = state(['--help']);
    assert(/phases:\s+ticket, code-review, test-plan,/.test(r.out), `phases line: ${r.out.split('\n').find(l => /phases/.test(l))}`);
  });

  check('a fresh run resumes at code-review once ticket passes', () => {
    assert(state(['set', 'ticket', 'pass']).status === 0, 'set ticket pass failed');
    const r = state(['get']);
    assert(/resume at: code-review/.test(r.out), `resume line: ${r.out.split('\n').pop()}`);
  });

  check('code-review seeds read-diff, scan, risks, repro-cases', () => {
    const r = state(['set', 'code-review', 'in_progress']);
    assert(r.status === 0, `code-review in_progress was refused: ${r.out.slice(0, 160)}`);
    const steps = Object.keys(stateJson().phases['code-review'].steps);
    assert(steps.join(',') === 'read-diff,scan,risks,repro-cases', `steps: ${steps.join(',')}`);
    assert(/resume at: code-review\/read-diff/.test(state(['get']).out), 'resume point should name the sub-step');
  });

  check('code-review needs no approval: steps and pass work before test-plan', () => {
    for (const s of ['read-diff', 'scan', 'risks', 'repro-cases']) {
      const r = state(['step', 'code-review', s, 'pass']);
      assert(r.status === 0, `step ${s} refused: ${r.out.slice(0, 160)}`);
    }
    assert(state(['set', 'code-review', 'pass', '3 repro cases']).status === 0, 'set code-review pass refused');
    assert(/resume at: test-plan/.test(state(['get']).out), 'should resume at test-plan next');
  });

  check('the test-plan gate still blocks every later phase', () => {
    for (const phase of ['contract', 'smoke', 'phone', 'unit-tests', 'report']) {
      const r = state(['set', phase, 'in_progress']);
      assert(r.status !== 0 && /BLOCKED: test-plan/.test(r.out), `${phase} was not blocked (exit ${r.status})`);
    }
    const step = state(['step', 'phone', 'case-1', 'pass']);
    assert(step.status !== 0 && /BLOCKED/.test(step.out), 'a device sub-step slipped past the gate');
  });

  check('the gate opens once test-plan passes', () => {
    assert(state(['set', 'test-plan', 'pass']).status === 0, 'set test-plan pass failed');
    const r = state(['set', 'contract', 'in_progress']);
    assert(r.status === 0, `contract still blocked after approval: ${r.out.slice(0, 160)}`);
  });

  check('a state.json from before code-review still loads and resumes in place', () => {
    // Open a run for a second ticket, then overwrite its state with an old-format file.
    assert(state(['set', 'ticket', 'pass'], 'ABC-124').status === 0, 'could not open a second run');
    const runDir = (state(['get'], 'ABC-124').out.match(/run: (\S+)/) || [])[1];
    assert(runDir, 'no run dir in get output');
    const file = path.join(host, runDir, 'state.json');
    const old = {
      ticket: 'ABC-124', env: 'staging', runId: path.basename(runDir), createdAt: '2026-01-01T00:00:00.000Z',
      phases: {
        ticket: { status: 'pass' },
        'test-plan': { status: 'pass' },
        contract: { status: 'pass' },
        smoke: { status: 'in_progress', steps: { health: { status: 'pass' }, auth: { status: 'pending' } } },
      },
    };
    fs.writeFileSync(file, JSON.stringify(old, null, 2));
    const r = state(['get'], 'ABC-124');
    assert(r.status === 0, `get on an old state failed: ${r.out.slice(0, 160)}`);
    assert(/resume at: smoke\/auth/.test(r.out), `old run should resume at smoke/auth: ${r.out.split('\n').pop()}`);
    assert(/code-review\s+skipped/.test(r.out), 'code-review should read as skipped on an old run');
    const w = state(['step', 'smoke', 'auth', 'pass'], 'ABC-124');
    assert(w.status === 0, `writing to an old run failed: ${w.out.slice(0, 160)}`);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert(saved.phases['code-review'] && saved.phases['code-review'].status === 'skipped', 'upgrade not written back');
    assert(saved.phases.smoke.steps.auth.status === 'pass', 'the step write was lost');
  });

  check('an old run that stopped before test-plan does the code review next', () => {
    assert(state(['set', 'ticket', 'pass'], 'ABC-125').status === 0, 'could not open a third run');
    const runDir = (state(['get'], 'ABC-125').out.match(/run: (\S+)/) || [])[1];
    const file = path.join(host, runDir, 'state.json');
    fs.writeFileSync(file, JSON.stringify({ ticket: 'ABC-125', env: 'staging', phases: { ticket: { status: 'pass' } } }));
    assert(/resume at: code-review/.test(state(['get'], 'ABC-125').out), 'should resume at code-review');
  });
} finally {
  fs.rmSync(host, { recursive: true, force: true });
}

process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`);
process.exit(failures ? 1 : 0);
