#!/usr/bin/env node
'use strict';

// Checks for runtime/review-scan.js: every rule on a positive fixture, the
// key negatives, masking, config (disable, layers), lint parsing, and the
// CLI against throwaway git repos. No network, no real linter.
//
//   node test/scan.js

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCAN = path.join(ROOT, 'runtime', 'review-scan.js');
const S = require(SCAN);

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
  if (!cond) {throw new Error(msg);}
}

// Every line of `content` counts as added unless `addedLines` names them.
function scan(file, content, opts = {}, addedLines) {
  const lines = content.split('\n');
  const added = lines
    .map((text, i) => ({ line: i + 1, text, hunk: 0 }))
    .filter(a => !addedLines || addedLines.includes(a.line));
  return S.scanFile({ file, content, added, removed: 0 }, opts);
}

function ids(leads) {
  return leads.map(l => l.rule);
}

const LOCALIZED = { packages: [{ dir: '', name: 'demo_app' }], layouts: [], localized: true, hasTheme: true };

function fires(rule, file, content, opts) {
  check(`${rule} fires: ${file}`, () => {
    const got = ids(scan(file, content, opts));
    assert(got.some(r => r === rule || r.startsWith(`${rule}:`)), `expected ${rule}, got [${got.join(', ')}]`);
  });
}

function quiet(rule, label, file, content, opts) {
  check(`${rule} quiet: ${label}`, () => {
    const got = ids(scan(file, content, opts));
    assert(!got.some(r => r === rule || r.startsWith(`${rule}:`)), `did not expect ${rule}, got [${got.join(', ')}]`);
  });
}

const SECRET = 'Zx9fK2mQ7pL4vB8nR1tY6wE3';

process.stdout.write('pure: owasp\n');
fires('hardcoded-secret', 'lib/core/env.dart', `const apiKey = '${SECRET}';`);
fires('hardcoded-secret', 'assets/config/env.json', `{ "client_secret": "${SECRET}" }`);
fires('hardcoded-secret', 'ios/Runner/Info.plist', `<key>MapsApiKey</key>\n<string>${SECRET}</string>`);
quiet('hardcoded-secret', 'storage key name, not a value', 'lib/a.dart', "const tokenKey = 'auth_token';\nfinal passwordField = 'password';");
check('hardcoded-secret masks the value everywhere', () => {
  const leads = scan('lib/core/env.dart', `const apiKey = '${SECRET}';`);
  const all = JSON.stringify(leads) + S.formatHuman({ base: 'main', mergeBase: '0'.repeat(40), head: '1'.repeat(40), filesScanned: 1, skippedGenerated: [], leads, lint: null, layers: [], summary: {} });
  assert(!all.includes(SECRET), 'raw secret printed');
  assert(all.includes(SECRET.slice(0, 4)), 'masked prefix missing');
});
fires('cleartext-http', 'lib/api.dart', "const base = 'http://api.example.com/v1';");
quiet('cleartext-http', 'localhost / emulator / xmlns', 'lib/api.dart', "const a = 'http://localhost:8080';\nconst b = 'http://10.0.2.2:3000';\nconst c = 'http://127.0.0.1';");
quiet('cleartext-http', 'android schema', 'android/app/src/main/AndroidManifest.xml', '<manifest xmlns:android="http://schemas.android.com/apk/res/android">');
fires('tls-bypass', 'lib/net.dart', 'client.badCertificateCallback = (cert, host, port) => true;');
fires('tls-bypass', 'android/app/src/main/AndroidManifest.xml', '<application android:usesCleartextTraffic="true">');
fires('tls-bypass', 'ios/Runner/Info.plist', '<key>NSAllowsArbitraryLoads</key>\n<true/>');
fires('tls-bypass', 'src/api.ts', 'const agent = new https.Agent({ rejectUnauthorized: false });');
fires('sensitive-log', 'lib/auth.dart', "debugPrint('login ok, token=$token');");
fires('sensitive-log', 'src/auth.ts', "console.log('password', password);");
quiet('sensitive-log', 'harmless log', 'lib/auth.dart', "debugPrint('list loaded');");
fires('insecure-storage', 'lib/auth.dart', "await prefs.setString('accessToken', token);");
fires('insecure-storage', 'src/auth.ts', "await AsyncStorage.setItem('refresh_token', t);");
quiet('insecure-storage', 'secure storage', 'lib/auth.dart', "await secureStorage.write(key: 'token', value: t);");
fires('webview-risk', 'lib/web.dart', 'controller.setJavaScriptMode(JavaScriptMode.unrestricted);');
fires('exported-component', 'android/app/src/main/AndroidManifest.xml', '<activity android:name=".Share" android:exported="true"/>');
fires('weak-crypto', 'lib/hash.dart', 'final h = md5.convert(utf8.encode(s));');
fires('weak-crypto', 'lib/otp.dart', 'final otp = Random().nextInt(9999);');
quiet('weak-crypto', 'Random.secure', 'lib/otp.dart', 'final otp = Random.secure().nextInt(9999);');
fires('deeplink-input', 'lib/router.dart', "final target = state.uri.queryParameters['url'];\nawait launchUrl(Uri.parse(target!));");
quiet('deeplink-input', 'param not sent anywhere', 'lib/router.dart', "final id = state.pathParameters['id'];\nreturn ProductPage(id: id);");
fires('dependency-change', 'pubspec.yaml', 'name: demo_app\ndependencies:\n  http: ^1.2.0');
fires('dependency-change', 'package.json', '{\n  "dependencies": {\n    "left-pad": "1.3.0"\n  }\n}');
check('dependency-change ignores the version field and sdk', () => {
  const got = scan('pubspec.yaml', 'name: demo_app\nversion: 1.0.0+1\nenvironment:\n  sdk: ">=3.0.0 <4.0.0"\ndependencies:\n  flutter:\n    sdk: flutter', {});
  assert(!ids(got).includes('dependency-change'), JSON.stringify(got));
});

process.stdout.write('pure: perf\n');
fires('non-lazy-list', 'lib/list.dart', 'return ListView(\n  children: items.map((i) => Tile(i)).toList(),\n);');
quiet('non-lazy-list', 'ListView.builder', 'lib/list.dart', 'return ListView.builder(\n  itemCount: items.length,\n  itemBuilder: (c, i) => Tile(items[i]),\n);');
quiet('non-lazy-list', 'static ListView', 'lib/list.dart', 'return ListView(\n  children: const [A(), B()],\n);');
fires('shrinkwrap-in-scroll', 'lib/list.dart', 'ListView.builder(shrinkWrap: true, itemBuilder: b);');
const BUILD = `class Page extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    final data = jsonDecode(raw);
    return ElevatedButton(
      onPressed: () async {
        final x = jsonDecode(raw);
      },
      child: Text('a'),
    );
  }
}`;
check('work-in-build fires in build and not in the onPressed handler', () => {
  const got = scan('lib/page.dart', BUILD).filter(l => l.rule === 'work-in-build').map(l => l.line);
  assert(got.includes(4) && !got.includes(7), `lines ${got}`);
});
fires('request-in-loop', 'lib/repo.dart', 'Future<void> load() async {\n  for (final id in ids) {\n    final p = await api.getProduct(id);\n  }\n}');
fires('request-in-loop', 'src/load.ts', 'async function load() {\n  for (const id of ids) {\n    await fetch(`/p/${id}`);\n  }\n}');
quiet('request-in-loop', 'Future.wait', 'lib/repo.dart', 'Future<void> load() async {\n  await Future.wait(ids.map((id) => api.getProduct(id)));\n}');
fires('image-no-cache-size', 'lib/img.dart', "Image.network(\n  url,\n  fit: BoxFit.cover,\n)");
quiet('image-no-cache-size', 'with cacheWidth', 'lib/img.dart', 'Image.network(\n  url,\n  cacheWidth: 300,\n)');
fires('setstate-in-loop', 'lib/s.dart', 'void initState() {\n  _scroll.addListener(() {\n    setState(() => offset = _scroll.offset);\n  });\n}');

process.stdout.write('pure: memory\n');
fires('unclosed-subscription', 'lib/s.dart', 'void initState() {\n  _sub = stream.listen((e) {});\n}');
quiet('unclosed-subscription', 'cancelled', 'lib/s.dart', 'void initState() {\n  _sub = stream.listen((e) {});\n}\nvoid dispose() {\n  _sub?.cancel();\n}');
fires('undisposed-controller', 'lib/form.dart', 'class _S extends State<F> {\n  final _name = TextEditingController();\n}');
quiet('undisposed-controller', 'disposed controller', 'lib/form.dart', 'class _S extends State<F> {\n  final _name = TextEditingController();\n  @override\n  void dispose() {\n    _name.dispose();\n    super.dispose();\n  }\n}');
check('undisposed-controller flags a controller created inline in build', () => {
  const got = scan('lib/form.dart', 'class P extends StatelessWidget {\n  Widget build(BuildContext context) {\n    return TextField(controller: TextEditingController());\n  }\n}');
  const l = got.find(x => x.rule === 'undisposed-controller');
  assert(l && /inline in build/.test(l.why), JSON.stringify(got));
});
fires('listener-not-removed', 'lib/s.dart', 'void initState() {\n  WidgetsBinding.instance.addObserver(this);\n}');
fires('listener-not-removed', 'src/s.ts', "useEffect(() => {\n  window.addEventListener('resize', onResize);\n}, []);");
quiet('listener-not-removed', 'removed in dispose', 'lib/s.dart', 'void initState() {\n  WidgetsBinding.instance.addObserver(this);\n}\nvoid dispose() {\n  WidgetsBinding.instance.removeObserver(this);\n}');
quiet('listener-not-removed', 'listener on an owned, disposed controller', 'lib/s.dart', 'final _c = ScrollController();\nvoid initState() {\n  _c.addListener(_onScroll);\n}\nvoid dispose() {\n  _c.dispose();\n}');
fires('global-cache-growth', 'lib/cache.dart', 'class C {\n  static final _cache = <String, int>{};\n  void put(String k, int v) {\n    _cache[k] = v;\n  }\n}');
quiet('global-cache-growth', 'cache with clear()', 'lib/cache.dart', 'class C {\n  static final _cache = <String, int>{};\n  void put(String k, int v) {\n    _cache[k] = v;\n  }\n  void reset() => _cache.clear();\n}');
fires('closure-captures-context', 'lib/helper.dart', 'class Helper {\n  final BuildContext context;\n  Helper(this.context);\n}');
quiet('closure-captures-context', 'widget field', 'lib/w.dart', 'class W extends StatelessWidget {\n  final BuildContext context;\n}');

process.stdout.write('pure: concurrency\n');
const AWAIT_CTX = `Future<void> _save() async {
  await repo.save();
  Navigator.of(context).pop();
}`;
fires('context-after-await', 'lib/p.dart', AWAIT_CTX);
quiet('context-after-await', 'mounted check after await', 'lib/p.dart', `Future<void> _save() async {
  await repo.save();
  if (!context.mounted) return;
  Navigator.of(context).pop();
}`);
quiet('context-after-await', 'context before the await', 'lib/p.dart', `Future<void> _save() async {
  final nav = Navigator.of(context);
  await repo.save();
}`);
fires('context-after-await', 'lib/p.dart', `Widget build(BuildContext context) {
  return TextButton(
    onPressed: () async {
      await repo.save();
      ScaffoldMessenger.of(context).showSnackBar(bar);
    },
    child: label,
  );
}`);
fires('setstate-after-await', 'lib/p.dart', 'Future<void> _load() async {\n  final x = await repo.load();\n  setState(() => items = x);\n}');
quiet('setstate-after-await', 'if (mounted)', 'lib/p.dart', 'Future<void> _load() async {\n  final x = await repo.load();\n  if (mounted) setState(() => items = x);\n}');
fires('bloc-no-transformer', 'lib/search_bloc.dart', 'SearchBloc() : super(const S()) {\n  on<SearchChanged>(_onChanged);\n}');
quiet('bloc-no-transformer', 'restartable()', 'lib/search_bloc.dart', 'SearchBloc() : super(const S()) {\n  on<SearchChanged>(\n    _onChanged,\n    transformer: restartable(),\n  );\n}');
quiet('bloc-no-transformer', 'non-search event', 'lib/cart_bloc.dart', 'CartBloc() : super(const S()) {\n  on<CartItemAdded>(_onAdded);\n}');
fires('unawaited-future', 'lib/x.dart', 'void go() {\n  Future.delayed(const Duration(seconds: 1), () => close());\n}');
fires('unawaited-future', 'lib/x.dart', 'void go() {\n  repo.load().then((v) => show(v));\n}');
quiet('unawaited-future', 'then with catchError', 'lib/x.dart', 'void go() {\n  repo.load().then((v) => show(v)).catchError((e) => fail(e));\n}');
fires('shared-mutable-static', 'lib/x.dart', 'class Session {\n  static String? token;\n}');
quiet('shared-mutable-static', 'static final / static method', 'lib/x.dart', 'class Session {\n  static final instance = Session();\n  static Future<void> init() async {}\n}');
fires('double-submit', 'lib/pay.dart', "ElevatedButton(\n  onPressed: () async {\n    await bloc.pay();\n  },\n  child: Text('Pay'),\n)");
quiet('double-submit', 'guarded by isLoading', 'lib/pay.dart', 'ElevatedButton(\n  onPressed: isLoading ? null : () async {\n    await bloc.pay();\n  },\n)');

process.stdout.write('pure: standards\n');
fires('debug-leftover', 'lib/x.dart', "void f() {\n  print('here');\n}");
fires('todo-added', 'lib/x.dart', '// TODO: handle the error');
fires('lint-suppressed', 'lib/x.dart', '// ignore: avoid_dynamic_calls');
fires('lint-suppressed', 'src/x.ts', '// @ts-ignore');
check('large-file fires past review.maxFileLines when the file grew', () => {
  const body = Array.from({ length: 30 }, (_, i) => `final v${i} = ${i};`).join('\n');
  const got = scan('lib/big.dart', body, { review: { maxFileLines: 20, maxFunctionLines: 80, disable: [] } });
  assert(ids(got).includes('large-file'), ids(got).join(','));
});
check('large-function fires on a long added function', () => {
  const body = `void f() {\n${Array.from({ length: 12 }, (_, i) => `  g(${i});`).join('\n')}\n}`;
  const got = scan('lib/fn.dart', body, { review: { maxFileLines: 600, maxFunctionLines: 10, disable: [] } });
  assert(ids(got).includes('large-function'), ids(got).join(','));
});
fires('hardcoded-ui-string', 'lib/w.dart', "return Text('Add to cart');", { repo: LOCALIZED });
fires('hardcoded-ui-string', 'src/W.tsx', 'return <Text>Add to cart</Text>;', { repo: LOCALIZED });
quiet('hardcoded-ui-string', 'translated', 'lib/w.dart', "return Text('cart.add'.tr());", { repo: LOCALIZED });
quiet('hardcoded-ui-string', 'not a localised repo', 'lib/w.dart', "return Text('Add to cart');");
fires('magic-colors', 'lib/features/cart/presentation/w.dart', 'color: Color(0xFF112233),', { repo: LOCALIZED });

process.stdout.write('pure: architecture\n');
const LAYOUT = { packages: [{ dir: '', name: 'demo_app' }], layouts: [{ src: 'lib', stack: 'dart' }], localized: false, hasTheme: false };
const DEF = S.layersFor({ layers: [] }, LAYOUT);
fires('layer-import', 'lib/features/cart/domain/usecases/add.dart', "import 'package:demo_app/features/cart/data/models/item.dart';", { repo: LAYOUT, layers: DEF });
fires('layer-import', 'lib/features/cart/domain/entities/item.dart', "import 'package:flutter/material.dart';", { repo: LAYOUT, layers: DEF });
fires('layer-import', 'lib/features/cart/presentation/page.dart', "import '../data/cart_repository_impl.dart';", { repo: LAYOUT, layers: DEF });
fires('layer-import', 'lib/features/cart/presentation/page.dart', "import 'package:demo_app/features/auth/presentation/login_page.dart';", { repo: LAYOUT, layers: DEF });
quiet('layer-import', 'same feature presentation -> domain', 'lib/features/cart/presentation/page.dart', "import 'package:demo_app/features/cart/domain/entities/item.dart';\nimport '../widgets/tile.dart';", { repo: LAYOUT, layers: DEF });
quiet('layer-import', 'other feature domain is allowed', 'lib/features/cart/presentation/page.dart', "import 'package:demo_app/features/auth/domain/user.dart';", { repo: LAYOUT, layers: DEF });
check('config layers override the defaults', () => {
  const custom = [{ name: 'no-dio-in-ui', files: 'lib/**/presentation/**', mustNotImport: ['package:dio/'], why: 'ui talks to repositories' }];
  const layers = S.layersFor({ layers: custom }, LAYOUT);
  assert(layers.length === 1 && layers[0].name === 'no-dio-in-ui', 'defaults not replaced');
  const got = scan('lib/features/cart/presentation/page.dart', "import 'package:dio/dio.dart';\nimport '../data/repo_impl.dart';", { repo: LAYOUT, layers });
  const rs = ids(got);
  assert(rs.includes('layer-import:no-dio-in-ui') && !rs.includes('layer-import:presentation-not-data'), rs.join(','));
});
fires('service-locator-in-ui', 'lib/features/cart/presentation/page.dart', 'Widget build(BuildContext context) {\n  final repo = getIt<CartRepository>();\n  return X();\n}');
fires('di-bypass', 'lib/features/cart/data/api.dart', 'final dio = Dio();');
quiet('di-bypass', 'inside lib/core/network', 'lib/core/network/client.dart', 'final dio = Dio();', { review: { httpClientDirs: ['lib/core/network'], disable: [], maxFileLines: 600, maxFunctionLines: 80 } });

process.stdout.write('pure: filtering, helpers\n');
check('generated *.g.dart is skipped', () => {
  assert(scan('lib/models/item.g.dart', `const apiKey = '${SECRET}';\nprint('x');`).length === 0, 'scanned');
});
check('test file gets only the secret rule', () => {
  const got = ids(scan('test/auth_test.dart', `const apiKey = '${SECRET}';\nprint('token $token');\n// TODO: more`));
  assert(got.length === 1 && got[0] === 'hardcoded-secret', got.join(','));
});
check('only added lines are leads', () => {
  const got = scan('lib/x.dart', "print('old');\nprint('new');", {}, [2]);
  assert(got.length === 1 && got[0].line === 2, JSON.stringify(got));
});
check('review.disable suppresses a rule', () => {
  const got = ids(scan('lib/x.dart', "void f() {\n  print('here');\n}", { review: { disable: ['debug-leftover'], maxFileLines: 600, maxFunctionLines: 80 } }));
  assert(!got.includes('debug-leftover'), got.join(','));
});
check('globToRegex: ** * ? {a,b}', () => {
  assert(S.globMatch('lib/**/domain/**', 'lib/features/x/domain/a.dart'), '**');
  assert(S.globMatch('lib/*.dart', 'lib/main.dart') && !S.globMatch('lib/*.dart', 'lib/a/main.dart'), '*');
  assert(S.globMatch('lib/?.dart', 'lib/a.dart'), '?');
  assert(S.globMatch('react{,/**}', 'react') && S.globMatch('react{,/**}', 'react/jsx-runtime') && !S.globMatch('react{,/**}', 'react-native'), '{}');
});
check('resolveImport: package and relative imports', () => {
  const pk = [{ dir: '', name: 'demo_app' }];
  assert(S.resolveImport('package:demo_app/core/a.dart', 'lib/x/y.dart', pk) === 'lib/core/a.dart', 'package');
  assert(S.resolveImport('../data/b.dart', 'lib/f/presentation/p.dart', pk) === 'lib/f/data/b.dart', 'relative');
  assert(S.resolveImport('package:flutter/material.dart', 'lib/a.dart', pk) === 'package:flutter/material.dart', 'external');
});
check('parseUnifiedDiff: hunk line numbers', () => {
  const diff = [
    'diff --git a/lib/a.dart b/lib/a.dart',
    'index 1..2 100644',
    '--- a/lib/a.dart',
    '+++ b/lib/a.dart',
    '@@ -3,0 +4,2 @@ class A {',
    '+  final x = 1;',
    '+  final y = 2;',
    '@@ -10 +12 @@',
    '-old',
    '+new',
    'diff --git a/gone.dart b/gone.dart',
    'deleted file mode 100644',
    '--- a/gone.dart',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-x',
  ].join('\n');
  const f = S.parseUnifiedDiff(diff);
  assert(f.length === 1 && f[0].file === 'lib/a.dart', JSON.stringify(f));
  assert(f[0].added.map(a => a.line).join(',') === '4,5,12' && f[0].removed === 1, JSON.stringify(f[0]));
  assert(f[0].added[2].hunk === 1, 'hunk index');
});
check('blankCode hides braces and await inside strings and comments', () => {
  const c = S.blankCode("final s = '{ await }'; // { await\nx();", 'dart');
  assert(!/await|\{/.test(c) && c.split('\n').length === 2, c);
});

process.stdout.write('pure: lint parsing\n');
const FLUTTER_OUT = [
  'Analyzing 2 items...',
  '',
  '  info • Unused import: \'package:foo/foo.dart\' • lib/a.dart:3:8 • unused_import',
  '  warning • The value of the local variable \'x\' isn\'t used • lib/b.dart:10:5 • unused_local_variable',
  '   info - lib/a.dart:9:1 - Avoid print calls in production code - avoid_print',
  '',
  '3 issues found. (ran in 1.2s)',
].join('\n');
check('parseLintOutput: flutter analyze (bullet and dash formats)', () => {
  const issues = S.parseLintOutput(FLUTTER_OUT, '/repo');
  assert(issues.length === 3, JSON.stringify(issues));
  assert(issues[0].file === 'lib/a.dart' && issues[0].line === 3 && issues[0].rule === 'unused_import', JSON.stringify(issues[0]));
  assert(issues[2].rule === 'avoid_print' && issues[2].line === 9, JSON.stringify(issues[2]));
});
check('parseLintOutput: eslint -f unix with absolute paths', () => {
  const issues = S.parseLintOutput('/repo/src/a.ts:4:7: \'x\' is assigned a value but never used. [Error/no-unused-vars]\n\n1 problem', '/repo');
  assert(issues.length === 1 && issues[0].file === 'src/a.ts' && issues[0].rule === 'no-unused-vars' && issues[0].severity === 'error', JSON.stringify(issues));
});
check('lintLeads keeps added lines, counts the rest', () => {
  const issues = S.parseLintOutput(FLUTTER_OUT, '/repo');
  const entries = [{ file: 'lib/a.dart', added: [{ line: 3, text: "import 'package:foo/foo.dart';", hunk: 0 }] }];
  const r = S.lintLeads(issues, entries, { disable: [] });
  assert(r.leads.length === 1 && r.leads[0].rule === 'lint:unused_import' && r.leads[0].dimension === 'standards', JSON.stringify(r.leads));
  assert(r.preExistingInTouchedFiles === 1 && r.outsideChangedFiles === 1, JSON.stringify(r));
});
check('lintCommandFor fills {files} quoted', () => {
  const cmd = S.lintCommandFor({ lintCommand: 'mylint {files}' }, '/nonexistent', ['lib/a b.dart'], false);
  assert(cmd === "mylint 'lib/a b.dart'", cmd);
});

// ------------------------------------------------------------ git + CLI

process.stdout.write('cli: throwaway git repos\n');

function sh(cwd, cmd, args) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function write(dir, file, text) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
}

function makeRepo(baseFiles, branchFiles, config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-scan-'));
  sh(dir, 'git', ['init', '-q', '-b', 'main']);
  sh(dir, 'git', ['config', 'user.email', 'qc@example.com']);
  sh(dir, 'git', ['config', 'user.name', 'QC Test']);
  sh(dir, 'git', ['config', 'commit.gpgsign', 'false']);
  for (const [f, t] of Object.entries(baseFiles)) {write(dir, f, t);}
  sh(dir, 'git', ['add', '-A']);
  sh(dir, 'git', ['commit', '-q', '-m', 'base']);
  sh(dir, 'git', ['checkout', '-q', '-b', 'feature/x']);
  for (const [f, t] of Object.entries(branchFiles)) {write(dir, f, t);}
  sh(dir, 'git', ['add', '-A']);
  sh(dir, 'git', ['commit', '-q', '-m', 'change']);
  if (config) {fs.writeFileSync(path.join(dir, 'qc.config.json'), JSON.stringify(config));}
  return dir;
}

function cli(cwd, args, env = {}) {
  const r = spawnSync(process.execPath, [SCAN, ...args], { cwd, encoding: 'utf8', env: { ...process.env, QC_RUN_DIR: '', ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const PUBSPEC = 'name: demo_app\ndependencies:\n  flutter:\n    sdk: flutter\n';
const OLD_IMPORT = "import 'package:demo_app/features/cart/data/models/item.dart';\n";
const baseFiles = {
  'pubspec.yaml': PUBSPEC,
  'lib/features/cart/domain/usecases/add.dart': `${OLD_IMPORT}\nclass AddToCart {}\n`,
  'lib/features/cart/data/models/item.dart': 'class Item {}\n',
  'lib/features/cart/presentation/page.dart': 'class Page {}\n',
  'lib/features/auth/presentation/login.dart': 'class Login {}\n',
};
const branchFiles = {
  'pubspec.yaml': `${PUBSPEC}  http: ^1.2.0\n`,
  'lib/features/cart/domain/usecases/add.dart': `${OLD_IMPORT}import 'package:flutter/material.dart';\n\nclass AddToCart {}\n`,
  'lib/features/cart/presentation/page.dart': [
    "import 'package:demo_app/features/auth/presentation/login.dart';",
    "import '../domain/usecases/add.dart';",
    '',
    'class _S extends State<P> {',
    '  final _scroll = ScrollController();',
    '  Future<void> _save() async {',
    '    await repo.save();',
    '    Navigator.of(context).pop();',
    '  }',
    '}',
    '',
  ].join('\n'),
  'lib/core/env.dart': `const apiKey = '${SECRET}';\nconst base = 'http://localhost:8080';\n`,
  'lib/models/item.g.dart': "print('generated');\n",
  'test/page_test.dart': "void main() {\n  print('token');\n}\n",
};

const repo = makeRepo(baseFiles, branchFiles);
let json = null;
check('CLI --json runs and exits 0', () => {
  const r = cli(repo, ['--json']);
  assert(r.code === 0, `exit ${r.code}: ${r.err}`);
  json = JSON.parse(r.out);
  for (const k of ['base', 'mergeBase', 'head', 'filesScanned', 'leads', 'lint', 'summary']) {assert(k in json, `missing ${k}`);}
  assert(json.base === 'main', json.base);
});
const leadsOf = rule => (json ? json.leads.filter(l => l.rule === rule || l.rule.startsWith(`${rule}:`)) : []);
check('CLI: pre-existing import is context, not a lead', () => {
  const layer = leadsOf('layer-import');
  assert(!layer.some(l => l.line === 1 && l.file.endsWith('add.dart')), JSON.stringify(layer));
  assert(layer.some(l => l.file.endsWith('add.dart') && l.line === 2), 'flutter import in domain not flagged');
  const pre = json.layers.find(l => l.name === 'domain-framework-free');
  assert(pre && pre.preExisting === 1, JSON.stringify(json.layers));
});
check('CLI: cross-feature import flagged, same-feature import not', () => {
  const page = leadsOf('layer-import').filter(l => l.file.endsWith('page.dart'));
  assert(page.length === 1 && page[0].rule === 'layer-import:no-cross-feature-internals' && page[0].line === 1, JSON.stringify(page));
});
check('CLI: undisposed controller, context-after-await, dependency, secret', () => {
  assert(leadsOf('undisposed-controller').length === 1, 'controller');
  assert(leadsOf('context-after-await').length === 1, 'context');
  assert(leadsOf('dependency-change').some(l => /http/.test(l.why)), 'dependency');
  assert(leadsOf('hardcoded-secret').length === 1, 'secret');
  assert(!leadsOf('cleartext-http').length, 'localhost flagged');
});
check('CLI: generated file skipped, test file only gets secrets', () => {
  assert(!json.leads.some(l => l.file.endsWith('.g.dart')), 'generated scanned');
  assert(!json.leads.some(l => l.file.startsWith('test/')), 'test file got non-secret leads');
  assert(json.skippedGenerated.includes('lib/models/item.g.dart'), 'skip not reported');
});
check('CLI: raw secret never printed (json and human)', () => {
  const h = cli(repo, []);
  assert(h.code === 0, h.err);
  assert(!h.out.includes(SECRET) && !JSON.stringify(json).includes(SECRET), 'secret printed');
  assert(/These are leads: confirm each in the code/.test(h.out), 'closing line missing');
  assert(/== owasp \(\d+\) ==/.test(h.out), 'dimension header missing');
});
check('CLI: --only limits dimensions', () => {
  const r = JSON.parse(cli(repo, ['--json', '--only', 'memory']).out);
  assert(r.leads.length && r.leads.every(l => l.dimension === 'memory'), JSON.stringify(r.summary));
});
check('CLI: --base as a commit', () => {
  const sha = sh(repo, 'git', ['rev-parse', 'main']).trim();
  const r = cli(repo, ['--json', '--base', sha]);
  assert(r.code === 0 && JSON.parse(r.out).mergeBase === sha, r.err);
});
check('CLI: --repo from another directory', () => {
  const r = cli(os.tmpdir(), ['--json', '--repo', repo, '--base', 'main']);
  assert(r.code === 0 && JSON.parse(r.out).filesScanned === json.filesScanned, r.err);
});
check('CLI: bad base exits 1, bad flag exits 1', () => {
  assert(cli(repo, ['--base', 'no-such-branch']).code === 1, 'bad base');
  assert(cli(repo, ['--bogus']).code === 1, 'bad flag');
});
check('CLI: --save writes scan.json and scan.md into QC_RUN_DIR', () => {
  const run = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qc-run-')), 'ABC-1', 'staging', 'r1');
  fs.mkdirSync(run, { recursive: true });
  const r = cli(repo, ['--save'], { QC_RUN_DIR: run });
  assert(r.code === 0, r.err);
  assert(fs.existsSync(path.join(run, 'review', 'scan.json')) && fs.existsSync(path.join(run, 'review', 'scan.md')), r.err);
  assert(!fs.readFileSync(path.join(run, 'review', 'scan.md'), 'utf8').includes(SECRET), 'secret in scan.md');
});

const cfgRepo = makeRepo(baseFiles, branchFiles, {
  repo: { defaultBranch: 'main' },
  review: {
    disable: ['hardcoded-secret'],
    layers: [{ name: 'ui-no-auth', files: 'lib/features/cart/**', mustNotImport: ['lib/features/auth/**'], why: 'cart stays independent' }],
    lintCommand: "printf 'lib/features/cart/presentation/page.dart:8:5: warning: x [some_rule]\\nlib/features/cart/presentation/page.dart:99:1: info: old [other_rule]\\n'",
  },
});
check('CLI with config: disable, custom layers, lintCommand', () => {
  const r = cli(cfgRepo, ['--json']);
  assert(r.code === 0, r.err);
  const j = JSON.parse(r.out);
  const rules = j.leads.map(l => l.rule);
  assert(!rules.includes('hardcoded-secret'), 'disabled rule ran');
  assert(rules.includes('layer-import:ui-no-auth') && !rules.includes('layer-import:no-cross-feature-internals'), rules.join(','));
  assert(rules.includes('lint:some_rule') && !rules.includes('lint:other_rule'), rules.join(','));
  assert(j.lint && j.lint.onAddedLines === 1 && j.lint.preExistingInTouchedFiles === 1, JSON.stringify(j.lint));
});

process.stdout.write(`\n${checks - failures}/${checks} checks passed\n`);
process.exit(failures ? 1 : 0);
