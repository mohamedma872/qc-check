#!/usr/bin/env node
'use strict';

// PR intake, worktree builds and install verification, with no network and
// no device: pure logic from runtime/repo-host.js and runtime/build.js, plus
// the pr.js and build.js CLIs against throwaway local git repositories.
//
//   node test/intake.js

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PR = path.join(ROOT, 'runtime', 'pr.js');
const BUILD = path.join(ROOT, 'runtime', 'build.js');

const host = require('../runtime/repo-host.js');
const build = require('../runtime/build.js');

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

function eq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: expected ${e}, got ${a}`);
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-intake-'));
const scrubbedEnv = { ...process.env };
delete scrubbedEnv.BITBUCKET_EMAIL;
delete scrubbedEnv.BITBUCKET_API_TOKEN;
delete scrubbedEnv.QC_RUN_DIR;

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function node(args, opts) {
  const res = spawnSync(process.execPath, args, { encoding: 'utf8', env: scrubbedEnv, ...opts });
  return { status: res.status, out: `${res.stdout || ''}${res.stderr || ''}`, stdout: res.stdout || '' };
}

// A repo with one commit and the given remote URL.
function repoWithRemote(name, url, config) {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'remote', 'add', 'origin', url);
  if (config) fs.writeFileSync(path.join(dir, 'qc.config.json'), JSON.stringify(config, null, 2));
  return dir;
}

// --- fixtures -------------------------------------------------------------------

const BITBUCKET_PR = {
  id: 42,
  title: 'Open product pages from deep links',
  description: 'Adds a handler for product links.\n\n- AC1: a product link opens the product page',
  state: 'OPEN',
  author: { display_name: 'Pat Example', nickname: 'pat' },
  source: { branch: { name: 'feature/abc-123-deeplinks' }, commit: { hash: '0123456789ab' } },
  destination: { branch: { name: 'main' }, commit: { hash: 'fedcba987654' } },
  links: { html: { href: 'https://example.com/your-org/your-app/pull-requests/42' } },
};

const GITHUB_PR = {
  number: 7,
  title: 'ABC-456: tidy the cart badge',
  body: 'Badge shows the item count.',
  headRefName: 'fix/cart-badge',
  baseRefName: 'main',
  headRefOid: '89abcdef0123456789abcdef0123456789abcdef',
  author: { login: 'octo', name: 'Octo Example' },
  url: 'https://github.com/your-org/your-app/pull/7',
  state: 'OPEN',
};

const DUMPSYS_BEFORE = [
  'Packages:',
  '  Package [com.example.app.staging] (1a2b3c):',
  '    userId=10190',
  '    versionCode=41 minSdk=24 targetSdk=34',
  '    versionName=1.4.0',
  '    firstInstallTime=2026-10-20 09:12:01',
  '    lastUpdateTime=2026-10-25 17:40:12',
].join('\n');

const DUMPSYS_AFTER = DUMPSYS_BEFORE
  .replace('versionCode=41', 'versionCode=42')
  .replace('lastUpdateTime=2026-10-25 17:40:12', 'lastUpdateTime=2026-10-26 10:03:55');

const DUMPSYS_ABSENT = 'Dexopt state:\n  Unable to find package: com.example.app.staging\n';

const ADB_FAILURE_OUTPUT = [
  '✓ Built build/app/outputs/flutter-apk/app-staging-debug.apk',
  'Performing Streamed Install',
  "Exception occurred while executing 'install':",
  'java.lang.IllegalStateException: system_server is not responding',
  '\tat com.android.server.pm.PackageManagerShellCommand.runInstall(PackageManagerShellCommand.java:1400)',
  "cmd: Can't find service: package",
].join('\n');

const DUMPSYS_DEAD = "Can't find service: package\n";

// --- remote parsing and host detection -------------------------------------------

check('parseRemote: GitHub over ssh', () => {
  const r = host.parseRemote('git@github.com:your-org/your-app.git');
  eq([r.hostname, r.owner, r.repo, r.slug], ['github.com', 'your-org', 'your-app', 'your-org/your-app'], 'parts');
});

check('parseRemote: GitHub over https, with and without .git', () => {
  eq(host.parseRemote('https://github.com/your-org/your-app.git').slug, 'your-org/your-app', 'with .git');
  eq(host.parseRemote('https://github.com/your-org/your-app').slug, 'your-org/your-app', 'without .git');
  eq(host.parseRemote('https://github.com/your-org/your-app/').repo, 'your-app', 'trailing slash');
});

check('parseRemote: Bitbucket over ssh and https (with a user)', () => {
  const ssh = host.parseRemote('git@bitbucket.org:your-workspace/your-app.git');
  eq([ssh.hostname, ssh.owner, ssh.repo], ['bitbucket.org', 'your-workspace', 'your-app'], 'ssh');
  const https = host.parseRemote('https://someone@bitbucket.org/your-workspace/your-app.git');
  eq([https.hostname, https.owner, https.repo], ['bitbucket.org', 'your-workspace', 'your-app'], 'https');
});

check('parseRemote: ssh:// URLs with a port, and junk', () => {
  eq(host.parseRemote('ssh://git@github.com:22/your-org/your-app.git').slug, 'your-org/your-app', 'ssh://');
  eq(host.parseRemote(''), null, 'empty');
  eq(host.parseRemote('/srv/git/app.git'), null, 'local path');
  eq(host.parseRemote('https://github.com/only-owner'), null, 'no repo part');
});

check('detectHost: github, bitbucket, anything else is none', () => {
  eq(host.detectHost(host.parseRemote('git@github.com:a/b.git')), 'github', 'github.com');
  eq(host.detectHost(host.parseRemote('https://github.example.com/a/b')), 'github', 'enterprise');
  eq(host.detectHost(host.parseRemote('git@bitbucket.org:a/b.git')), 'bitbucket', 'bitbucket cloud');
  eq(host.detectHost(host.parseRemote('https://git.example.com/a/b.git')), 'none', 'other');
  eq(host.detectHost(null), 'none', 'no remote');
});

check('resolveHost: repo.host wins, empty detects, junk is rejected', () => {
  const bb = host.parseRemote('git@bitbucket.org:a/b.git');
  eq(host.resolveHost('', bb), { kind: 'bitbucket', detected: true }, 'detected');
  eq(host.resolveHost('github', bb), { kind: 'github', detected: false }, 'configured');
  let threw = false;
  try { host.resolveHost('gitlab', bb); } catch (_) { threw = true; }
  assert(threw, 'an unknown repo.host must throw');
});

// --- ticket ids ------------------------------------------------------------------

check('deriveTicketId: a key in the title wins', () => {
  const pr = host.fromGithub(GITHUB_PR);
  eq(host.deriveTicketId(pr, '[A-Z]+-[0-9]+'), { id: 'ABC-456', source: 'title' }, 'title key');
});

check('deriveTicketId: a lower-case key in the branch', () => {
  const pr = host.fromBitbucket(BITBUCKET_PR);
  eq(host.deriveTicketId(pr, '[A-Z]+-[0-9]+'), { id: 'ABC-123', source: 'branch' }, 'branch key');
});

check('deriveTicketId: no key anywhere gives PR-<n>', () => {
  const pr = { number: 302, title: 'Tidy the settings screen', sourceBranch: 'feature/settings' };
  eq(host.deriveTicketId(pr, '[A-Z]+-[0-9]+'), { id: 'PR-302', source: 'pseudo' }, 'pseudo');
});

check('deriveTicketId: a pattern that rejects PR-<n> explains itself', () => {
  const pr = { number: 9, title: 'No key', sourceBranch: 'chore/x' };
  const r = host.deriveTicketId(pr, 'ABC-[0-9]+');
  assert(r.id === null, `expected no id, got ${r.id}`);
  assert(/does not match tracker\.ticketPattern/.test(r.reason) && /PR-\[0-9\]\+/.test(r.reason), r.reason);
  const only = host.deriveTicketId({ number: 9, title: 'ABC-77 fix', sourceBranch: '' }, 'ABC-[0-9]+');
  eq(only.id, 'ABC-77', 'a narrow pattern still finds its own key');
});

// --- ticket.md ---------------------------------------------------------------------

check('renderTicket: Bitbucket fixture in the tracker.js markdown shape', () => {
  const pr = host.fromBitbucket(BITBUCKET_PR);
  const md = host.renderTicket(pr, 'ABC-123', '2026-10-26T10:00:00.000Z');
  const lines = md.split('\n');
  eq(lines[0], '# ABC-123 - Open product pages from deep links', 'heading');
  assert(lines[2] === 'Source: https://example.com/your-org/your-app/pull-requests/42 (fetched 2026-10-26T10:00Z)', lines[2]);
  assert(md.includes('Type: Pull request · Status: OPEN · Author: Pat Example · Host: bitbucket'), 'summary line');
  assert(md.includes('Branch under test: feature/abc-123-deeplinks -> main · Head commit: 0123456789ab'), 'branch line');
  assert(md.includes('## Description\n\nAdds a handler for product links.'), 'description');
  assert(md.includes('- AC1: a product link opens the product page'), 'acceptance criterion kept');
  assert(md.includes('## Pull request') && md.includes('- Number: #42'), 'PR section');
});

check('renderTicket: GitHub fixture and an empty description', () => {
  const pr = host.fromGithub({ ...GITHUB_PR, body: '' });
  const md = host.renderTicket(pr, 'ABC-456');
  assert(md.startsWith('# ABC-456 - ABC-456: tidy the cart badge\n'), md.split('\n')[0]);
  assert(md.includes('Author: Octo Example') && md.includes('fix/cart-badge -> main'), 'facts');
  assert(md.includes('## Description\n\n(empty)'), 'empty description marker');
});

// --- comments -----------------------------------------------------------------------

check('planComment: Bitbucket create and update requests', () => {
  const remote = host.parseRemote('git@bitbucket.org:your-workspace/your-app.git');
  const p = host.planComment({ kind: 'bitbucket', remote, number: 42, body: 'hi' });
  eq([p.method, p.hostname, p.path], ['POST', 'api.bitbucket.org', '/2.0/repositories/your-workspace/your-app/pullrequests/42/comments'], 'create');
  eq(p.payload, { content: { raw: 'hi' } }, 'payload');
  const u = host.planComment({ kind: 'bitbucket', remote, number: 42, body: 'hi', updateId: '99' });
  eq([u.method, u.path.endsWith('/comments/99')], ['PUT', true], 'update');
});

check('planComment: GitHub uses gh, and refuses host none', () => {
  const remote = host.parseRemote('git@github.com:your-org/your-app.git');
  const p = host.planComment({ kind: 'github', remote, number: 7, body: 'hi' });
  eq(p.command.slice(0, 5), ['gh', 'pr', 'comment', '7', '-R'], 'gh pr comment');
  const u = host.planComment({ kind: 'github', remote, number: 7, body: 'hi', updateId: '5' });
  assert(u.command.includes('PATCH') && u.command.includes('repos/your-org/your-app/issues/comments/5'), u.command.join(' '));
  let threw = false;
  try { host.planComment({ kind: 'none', remote, number: 7, body: 'x' }); } catch (_) { threw = true; }
  assert(threw, 'host none must throw');
});

// Preloaded into pr.js: any network write or gh call is a test failure.
const NO_NET = path.join(tmpRoot, 'no-net.js');
fs.writeFileSync(NO_NET, `
const boom = what => () => { throw new Error('NETWORK CALLED: ' + what); };
require('https').request = boom('https.request');
require('http').request = boom('http.request');
require('net').connect = boom('net.connect');
const cp = require('child_process');
for (const fn of ['spawnSync', 'execFileSync', 'spawn', 'execFile']) {
  const orig = cp[fn];
  cp[fn] = function (cmd, ...rest) {
    if (cmd === 'gh' || cmd === 'curl') throw new Error('NETWORK CALLED: ' + cmd);
    return orig.call(this, cmd, ...rest);
  };
}
`);

const commentFile = path.join(tmpRoot, 'comment.md');
fs.writeFileSync(commentFile, 'QC: PASS\n\nThe product page opens from a link.\n');

check('pr.js comment --dry-run on Bitbucket: no network, no credentials needed', () => {
  const dir = repoWithRemote('bb', 'git@bitbucket.org:your-workspace/your-app.git');
  const r = node(['-r', NO_NET, PR, 'comment', '42', '--file', commentFile, '--dry-run'], { cwd: dir });
  assert(r.status === 0, `exit ${r.status}: ${r.out}`);
  assert(!/NETWORK CALLED/.test(r.out), r.out);
  assert(/DRY RUN: would create a comment on bitbucket your-workspace\/your-app PR #42/.test(r.out), r.out);
  assert(/POST api\.bitbucket\.org\/2\.0\/repositories\/your-workspace\/your-app\/pullrequests\/42\/comments/.test(r.out), r.out);
  assert(/nothing was sent/.test(r.out), r.out);
});

check('pr.js comment --update --dry-run on GitHub: no gh call', () => {
  const dir = repoWithRemote('gh', 'https://github.com/your-org/your-app.git');
  const r = node(['-r', NO_NET, PR, 'comment', '7', '--update', '5', '--file', commentFile, '--dry-run'], { cwd: dir });
  assert(r.status === 0, `exit ${r.status}: ${r.out}`);
  assert(!/NETWORK CALLED/.test(r.out), r.out);
  assert(/would update a comment on github your-org\/your-app PR #7, comment 5/.test(r.out), r.out);
});

check('the no-network guard itself trips', () => {
  const dir = repoWithRemote('bb2', 'git@bitbucket.org:your-workspace/your-app.git');
  const env = { ...scrubbedEnv, BITBUCKET_EMAIL: 'qa@example.com', BITBUCKET_API_TOKEN: 'not-a-real-token' };
  const r = node(['-r', NO_NET, PR, 'comment', '42', '--file', commentFile], { cwd: dir, env });
  assert(r.status !== 0 && /NETWORK CALLED: https\.request/.test(r.out), `guard did not trip: ${r.out}`);
  assert(!r.out.includes('not-a-real-token'), 'the token was printed');
});

check('pr.js: missing Bitbucket credentials name the variables, host none explains', () => {
  const dir = repoWithRemote('bb3', 'git@bitbucket.org:your-workspace/your-app.git');
  const r = node(['-r', NO_NET, PR, 'get', '42'], { cwd: dir });
  assert(r.status === 1 && /BITBUCKET_EMAIL, BITBUCKET_API_TOKEN/.test(r.out), r.out);
  const other = repoWithRemote('other', 'https://git.example.com/your-org/your-app.git');
  const o = node(['-r', NO_NET, PR, 'id', '1'], { cwd: other });
  assert(o.status === 1 && /no supported PR host/.test(o.out), o.out);
});

check('pr.js approve: skipped in eval mode, GitHub has no unapprove, no network either way', () => {
  const dir = repoWithRemote('bb4', 'git@bitbucket.org:your-workspace/your-app.git');
  const e = node(['-r', NO_NET, PR, 'approve', '42', '--dry-run'], { cwd: dir, env: { ...scrubbedEnv, QC_EVAL: '1' } });
  assert(e.status === 0 && /skipped: eval mode/.test(e.out) && !/NETWORK CALLED/.test(e.out), e.out);
  const gdir = repoWithRemote('gh2', 'https://github.com/your-org/your-app.git');
  const u = node(['-r', NO_NET, PR, 'unapprove', '7', '--dry-run'], { cwd: gdir });
  assert(u.status === 1 && /WARN: GitHub has no unapprove/.test(u.out) && !/NETWORK CALLED/.test(u.out), u.out);
});

check('pr.js approve: only a PASS run is approved, refused before any network call', () => {
  const dir = repoWithRemote('bb5', 'git@bitbucket.org:your-workspace/your-app.git');
  const r = node(['-r', NO_NET, PR, 'approve', '42', '--dry-run'], { cwd: dir, env: scrubbedEnv });
  assert(r.status === 1 && /refusing to approve/.test(r.out) && !/NETWORK CALLED/.test(r.out), r.out);
  // A FAIL report is refused too; a PASS report gets as far as reading the PR.
  const cdir = repoWithRemote('bb6', 'git@bitbucket.org:your-workspace/your-app.git', {});
  const RUNS = path.join(ROOT, 'runtime', 'runs.js');
  const runDir = node([RUNS, 'open', 'ABC-9'], { cwd: cdir }).stdout.trim().split('\n').pop();
  const approve = () => node(['-r', NO_NET, PR, 'approve', '42', '--dry-run'], { cwd: cdir, env: { ...scrubbedEnv, QC_RUN_DIR: runDir } });
  fs.writeFileSync(path.join(runDir, 'report.md'), '# QC\n\n## Overall: FAIL\n');
  const f = approve();
  assert(f.status === 1 && /refusing to approve.*FAIL/.test(f.out) && !/NETWORK CALLED/.test(f.out), f.out);
  fs.writeFileSync(path.join(runDir, 'report.md'), '# QC\n\n## Overall: PASS\n');
  const p = approve();
  assert(!/refusing to approve/.test(p.out) && /NETWORK CALLED|credentials are not in the environment/.test(p.out), p.out);
});

check('pr.js and build.js take --help', () => {
  for (const script of [PR, BUILD]) {
    const r = node([script, '--help']);
    assert(r.status === 0 && /Usage:/.test(r.out), `${path.basename(script)}: ${r.out}`);
  }
});

// --- build: skip logic -------------------------------------------------------------

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const stamp = { sha: SHA_A, flavor: 'staging', command: 'make apk', lastUpdateTime: '2026-10-26 10:03:55' };

check('shouldSkip: same commit, flavor and command, still installed: skip', () => {
  const d = build.shouldSkip(stamp, { sha: SHA_A, flavor: 'staging', command: 'make apk', installed: true, lastUpdateTime: '2026-10-26 10:03:55' });
  assert(d.skip, d.why);
});

check('shouldSkip: a new commit, flavor, command, --force or no stamp rebuilds', () => {
  const base = { sha: SHA_A, flavor: 'staging', command: 'make apk' };
  assert(!build.shouldSkip(stamp, { ...base, sha: SHA_B }).skip, 'new commit');
  assert(!build.shouldSkip(stamp, { ...base, flavor: 'uat' }).skip, 'new flavor');
  assert(!build.shouldSkip(stamp, { ...base, command: 'make apk2' }).skip, 'new command');
  assert(!build.shouldSkip(stamp, base, { force: true }).skip, '--force');
  assert(!build.shouldSkip(null, base).skip, 'no stamp');
});

check('shouldSkip: the app was uninstalled or replaced since: rebuild', () => {
  const base = { sha: SHA_A, flavor: 'staging', command: 'make apk' };
  assert(!build.shouldSkip(stamp, { ...base, installed: false }).skip, 'uninstalled');
  assert(!build.shouldSkip(stamp, { ...base, installed: true, lastUpdateTime: '2026-10-26 12:00:00' }).skip, 'replaced');
});

check('expandBuild and safeName', () => {
  eq(build.expandBuild('flutter build apk --flavor {flavor} -t lib/main_{flavor}.dart', 'dev'),
    'flutter build apk --flavor dev -t lib/main_dev.dart', 'expand');
  eq(build.safeName('feature/abc-123 deep links'), 'feature_abc-123_deep_links', 'safe');
});

// --- build: install verification ------------------------------------------------------

check('parseDumpsys: installed and absent packages', () => {
  const p = build.parseDumpsys(DUMPSYS_BEFORE, 'com.example.app.staging');
  eq([p.installed, p.lastUpdateTime, p.versionCode, p.versionName], [true, '2026-10-25 17:40:12', '41', '1.4.0'], 'installed');
  const a = build.parseDumpsys(DUMPSYS_ABSENT, 'com.example.app.staging');
  eq([a.installed, a.lastUpdateTime], [false, ''], 'absent');
  eq(build.parseDumpsys(DUMPSYS_DEAD, 'com.example.app.staging').serviceMissing, true, 'dead service');
});

check('verifyAndroidInstall: lastUpdateTime moved: ok', () => {
  const v = build.verifyAndroidInstall(DUMPSYS_BEFORE, DUMPSYS_AFTER, 'Performing Streamed Install\nSuccess\n', 'com.example.app.staging');
  assert(v.ok, v.problems.join('; '));
  eq(v.after.versionCode, '42', 'new version');
});

check('verifyAndroidInstall: a first install counts', () => {
  const v = build.verifyAndroidInstall(DUMPSYS_ABSENT, DUMPSYS_AFTER, 'Success', 'com.example.app.staging');
  assert(v.ok, v.problems.join('; '));
});

check('verifyAndroidInstall: unchanged lastUpdateTime fails: the old build is still there', () => {
  const v = build.verifyAndroidInstall(DUMPSYS_BEFORE, DUMPSYS_BEFORE, 'Success', 'com.example.app.staging');
  assert(!v.ok && /did not update/.test(v.problems.join(' ')) && /OLD build/.test(v.problems.join(' ')), v.problems.join('; '));
});

check('verifyAndroidInstall: adb Exception and "Can\'t find service" fail loudly', () => {
  const v = build.verifyAndroidInstall(DUMPSYS_BEFORE, DUMPSYS_DEAD, ADB_FAILURE_OUTPUT, 'com.example.app.staging');
  assert(!v.ok, 'should fail');
  const all = v.problems.join(' | ');
  assert(/Exception occurred while executing 'install'/.test(all), all);
  assert(/system_server is down/.test(all), all);
  const lines = build.installFailures(ADB_FAILURE_OUTPUT);
  assert(lines.some((l) => /^cmd: Can't find service: package$/.test(l)), lines.join(' | '));
  assert(lines.some((l) => /^java\.lang\.IllegalStateException/.test(l)), lines.join(' | '));
});

check('verifyAndroidInstall: a failure is caught even when dumpsys looks updated', () => {
  const v = build.verifyAndroidInstall(DUMPSYS_BEFORE, DUMPSYS_AFTER, 'Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE]', 'com.example.app.staging');
  assert(!v.ok && /INSTALL_FAILED_UPDATE_INCOMPATIBLE/.test(v.problems.join(' ')), v.problems.join('; '));
});

check('installFailures: a compiler warning that names an exception is not a failure', () => {
  const noise = "w: lib/Foo.kt:12: 'catch (e: Exception)' is redundant\nNote: Some input files use unchecked operations.\nBUILD SUCCESSFUL";
  eq(build.installFailures(noise), [], 'no false positive');
});

// --- build: prepare / clean against a local remote -------------------------------------

check('build.js prepare/run/clean: worktree, copied file, skip-if-same-SHA, main checkout untouched', () => {
  const origin = path.join(tmpRoot, 'origin.git');
  git(tmpRoot, 'init', '-q', '--bare', origin);
  const seed = path.join(tmpRoot, 'seed');
  git(tmpRoot, 'clone', '-q', origin, seed);
  fs.writeFileSync(path.join(seed, '.gitignore'), 'env/dev.json\n');
  fs.writeFileSync(path.join(seed, 'app.txt'), 'main\n');
  git(seed, 'add', '.');
  git(seed, '-c', 'user.email=qa@example.com', '-c', 'user.name=QC', 'commit', '-q', '-m', 'init');
  git(seed, 'push', '-q', 'origin', 'HEAD:main');
  git(seed, 'checkout', '-q', '-b', 'feature/abc-123-thing');
  fs.writeFileSync(path.join(seed, 'app.txt'), 'feature\n');
  git(seed, '-c', 'user.email=qa@example.com', '-c', 'user.name=QC', 'commit', '-q', '-am', 'feature');
  git(seed, 'push', '-q', 'origin', 'feature/abc-123-thing');

  const dev = path.join(tmpRoot, 'dev');
  git(tmpRoot, 'clone', '-q', '-b', 'main', origin, dev);
  fs.mkdirSync(path.join(dev, 'env'));
  fs.writeFileSync(path.join(dev, 'env', 'dev.json'), '{"API":"https://api.example.com"}\n');
  fs.writeFileSync(path.join(dev, 'wip.txt'), 'uncommitted work\n'); // the developer's own change
  const wtRoot = path.join(tmpRoot, 'worktrees');
  fs.writeFileSync(path.join(dev, 'qc.config.json'), JSON.stringify({
    app: { defaultFlavor: 'dev', build: { android: 'true', ios: 'echo {flavor} >> built.txt', worktreeDir: wtRoot, copyFiles: ['env/{flavor}.json'] }, flavors: { dev: {} } },
  }));
  fs.appendFileSync(path.join(dev, '.git', 'info', 'exclude'), 'qc.config.json\n');
  const statusBefore = git(dev, 'status', '--porcelain');
  const headBefore = git(dev, 'rev-parse', 'HEAD');

  const r = node([BUILD, 'prepare', '--branch', 'feature/abc-123-thing'], { cwd: dev });
  assert(r.status === 0, `prepare exit ${r.status}: ${r.out}`);
  const wt = path.join(wtRoot, 'feature_abc-123-thing');
  assert(fs.existsSync(path.join(wt, 'app.txt')), 'worktree missing');
  eq(fs.readFileSync(path.join(wt, 'app.txt'), 'utf8'), 'feature\n', 'worktree is on the branch');
  eq(fs.readFileSync(path.join(wt, 'env', 'dev.json'), 'utf8'), '{"API":"https://api.example.com"}\n', 'copied file');
  eq(git(wt, 'status', '--porcelain'), '', 'the copied file is ignored, not a change');
  eq(git(dev, 'status', '--porcelain'), statusBefore, 'developer status');
  eq(git(dev, 'rev-parse', 'HEAD'), headBefore, 'developer HEAD');
  eq(git(dev, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'developer branch');
  eq(git(dev, 'stash', 'list'), '', 'no stash');

  const again = node([BUILD, 'prepare', '--branch', 'feature/abc-123-thing'], { cwd: dev });
  assert(again.status === 0 && /worktree reused/.test(again.out), again.out);

  // No device: an iOS command that installs nothing exercises the stamp logic.
  const b1 = node([BUILD, 'run', '--platform', 'ios'], { cwd: dev });
  assert(b1.status === 0 && /build of feature\/abc-123-thing/.test(b1.out), b1.out);
  eq(fs.readFileSync(path.join(wt, 'built.txt'), 'utf8'), 'dev\n', 'the build ran in the worktree with {flavor} expanded');
  assert(!fs.existsSync(path.join(dev, 'built.txt')), 'the build ran in the main checkout');
  const b2 = node([BUILD, 'run', '--platform', 'ios'], { cwd: dev });
  assert(b2.status === 0 && /build skipped/.test(b2.out), b2.out);
  const b3 = node([BUILD, 'run', '--platform', 'ios', '--force'], { cwd: dev });
  assert(b3.status === 0 && !/build skipped/.test(b3.out), b3.out);
  eq(fs.readFileSync(path.join(wt, 'built.txt'), 'utf8'), 'dev\ndev\n', '--force rebuilt');

  const c = node([BUILD, 'clean'], { cwd: dev });
  assert(c.status === 0 && /OK: removed/.test(c.out), c.out);
  assert(!fs.existsSync(wt), 'worktree still on disk');
  assert(!git(dev, 'worktree', 'list').includes('feature_abc-123-thing'), 'worktree still registered');
  eq(git(dev, 'status', '--porcelain'), statusBefore, 'developer status after clean');
});

check('build.js refuses a worktreeDir that is the repository itself', () => {
  const dir = repoWithRemote('guard', 'git@github.com:your-org/your-app.git', { app: { build: { worktreeDir: '.' } } });
  const r = node([BUILD, 'clean'], { cwd: dir });
  assert(r.status === 1 && /must not be the repository/.test(r.out), r.out);
  assert(fs.existsSync(path.join(dir, 'qc.config.json')), 'the repo was touched');
});

fs.rmSync(tmpRoot, { recursive: true, force: true });

process.stdout.write(`\nintake: ${checks - failures}/${checks} passed\n`);
process.exit(failures === 0 ? 0 : 1);
