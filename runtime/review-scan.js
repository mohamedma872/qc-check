#!/usr/bin/env node
'use strict';

// QC - static PR scan for the code-review phase.
//
// Diffs the branch under test against its base and prints LEADS, grouped by
// six review dimensions (owasp, perf, memory, concurrency, standards,
// architecture). A lead is a line worth reading, not a finding: the rules
// are regexes plus a little brace counting, so they have false positives.
// The agent opens each lead in the code and records a finding only when the
// code confirms it.
//
// - Line rules see only ADDED lines (git diff -U0, hunk line numbers parsed).
// - File rules read the whole post-change file (e.g. "creates a controller
//   but never disposes it") but report only when the triggering line was
//   added in this diff, so old debt in a touched file is not blamed on it.
// - Generated and vendored files are skipped; test files get only the
//   secret rule. Secret values are always masked (api.js maskValue).
// - Rules live in one table (RULES) so adding one is a single entry.
//
// Known limits: brace and string tracking is per character with no real
// parser, so a function body is found by brace matching and a string that
// contains an odd quote can throw it off; "same function" means the nearest
// enclosing `{` whose header looks like a function or closure. Dart and
// JS/TS are covered best; Kotlin, Java and Swift get the line rules.
//
//   node qc/review-scan.js --help

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const { looksSecret, keyClass, maskValue } = require('./api.js');

const DIMENSIONS = ['owasp', 'perf', 'memory', 'concurrency', 'standards', 'architecture'];
const CODE = ['dart', 'js', 'jvm', 'swift'];
const CLOSING = 'These are leads: confirm each in the code before recording it as a finding.';

const REVIEW_DEFAULTS = {
  lintCommand: '',
  layers: [],
  disable: [],
  maxFileLines: 600,
  maxFunctionLines: 80,
  httpClientDirs: ['lib/core/network', 'lib/core/di', 'src/api', 'src/network'],
};

// --- arguments -----------------------------------------------------------------

function parseArgs(argv) {
  const out = { json: false, save: false, lint: false, help: false, only: null, base: null, repo: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) {throw new Error(`${a} needs a value`);}
      i += 1;
      return v;
    };
    if (a === '--json') {out.json = true;}
    else if (a === '--save') {out.save = true;}
    else if (a === '--lint') {out.lint = true;}
    else if (a === '--help' || a === '-h') {out.help = true;}
    else if (a === '--base') {out.base = value();}
    else if (a === '--repo') {out.repo = value();}
    else if (a === '--only') {
      out.only = value().split(',').map(s => s.trim()).filter(Boolean);
      const bad = out.only.filter(d => !DIMENSIONS.includes(d));
      if (bad.length) {throw new Error(`unknown dimension ${bad.join(', ')} (one of ${DIMENSIONS.join(', ')})`);}
    } else {throw new Error(`unknown option ${a}`);}
  }
  return out;
}

// --- files: which ones, and what stack -------------------------------------------

const GENERATED = [
  /\.(g|freezed|mocks|gr|config|chopper|pb|pbenum|pbjson|pbserver)\.dart$/,
  /(^|\/)(build|node_modules|Pods|\.dart_tool|\.gradle|DerivedData|vendor|dist|coverage|\.next|\.expo)\//,
  /(^|\/)generated\//,
  /(^|\/)l10n\/.*\.dart$/,
  /(^|\/)app_localizations(_\w+)?\.dart$/,
  /\.lock$/,
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Podfile\.lock|pubspec\.lock|Gemfile\.lock)$/,
  /\.min\.(js|css)$/,
  /\.(png|jpe?g|gif|webp|ico|ttf|otf|woff2?|mp4|mp3|zip|jar|keystore|jks|pdf|svg|lottie)$/i,
];
const TEST_FILE = [
  /(^|\/)(test|tests|__tests__|integration_test|test_driver|androidTest|testing|__mocks__)\//,
  /_test\.dart$/,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /Tests?\.(kt|java|swift)$/,
];

function isGenerated(file) {
  return GENERATED.some(re => re.test(file));
}

function isTestFile(file) {
  return TEST_FILE.some(re => re.test(file));
}

function stackOf(file) {
  const base = path.posix.basename(file);
  if (base === 'AndroidManifest.xml') {return 'android-manifest';}
  if (base === 'network_security_config.xml') {return 'netsec';}
  if (/\.plist$/.test(base)) {return 'plist';}
  if (/^(build|settings)\.gradle(\.kts)?$/.test(base)) {return 'gradle';}
  if (base === 'pubspec.yaml') {return 'pubspec';}
  if (base === 'package.json') {return 'package-json';}
  const ext = path.posix.extname(base).toLowerCase();
  if (ext === '.dart') {return 'dart';}
  if (['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].includes(ext)) {return 'js';}
  if (['.kt', '.kts', '.java'].includes(ext)) {return 'jvm';}
  if (['.swift', '.m', '.mm'].includes(ext)) {return 'swift';}
  if (['.md', '.txt', '.rst', '.adoc'].includes(ext)) {return 'doc';}
  if (['.json', '.yaml', '.yml', '.xml', '.env', '.properties', '.xcconfig', '.toml', '.ini', '.cfg', '.arb'].includes(ext) || base.startsWith('.env')) {return 'config';}
  return 'other';
}

// --- unified diff ----------------------------------------------------------------

function unquotePath(p) {
  if (!p.startsWith('"')) {return p;}
  try {
    return JSON.parse(p);
  } catch (_) {
    return p.slice(1, -1);
  }
}

// `git diff -U0` text -> [{ file, status, added: [{ line, text, hunk }], removed }].
function parseUnifiedDiff(text) {
  const files = [];
  let cur = null;
  let newLine = 0;
  let hunk = -1;
  let inHunk = false;
  for (const raw of String(text).split('\n')) {
    if (raw.startsWith('diff --git ')) {
      cur = { file: null, status: 'modified', added: [], removed: 0 };
      files.push(cur);
      inHunk = false;
      hunk = -1;
      continue;
    }
    if (!cur) {continue;}
    if (!inHunk) {
      if (raw.startsWith('new file mode')) {cur.status = 'added';}
      else if (raw.startsWith('deleted file mode')) {cur.status = 'deleted';}
      else if (raw.startsWith('rename to ')) {cur.status = 'renamed';}
      else if (raw.startsWith('+++ ')) {
        const p = unquotePath(raw.slice(4).trim());
        cur.file = p === '/dev/null' ? null : p.replace(/^b\//, '');
        continue;
      }
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (h) {
      newLine = Number(h[1]);
      hunk += 1;
      inHunk = true;
      continue;
    }
    if (!inHunk) {continue;}
    if (raw.startsWith('+')) {
      cur.added.push({ line: newLine, text: raw.slice(1), hunk });
      newLine += 1;
    } else if (raw.startsWith('-')) {
      cur.removed += 1;
    } else if (raw.startsWith(' ')) {
      newLine += 1;
    }
  }
  return files.filter(f => f.file && f.status !== 'deleted');
}

// --- code blanking and brace spans -----------------------------------------------

// Same text with comments and string contents replaced by spaces (newlines
// kept), so braces, `await` and `context` are only ever matched in code.
function blankCode(text, stack) {
  const n = text.length;
  let out = '';
  let i = 0;
  const hash = stack === 'config';
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if ((c === '/' && d === '/') || (hash && c === '#')) {
      while (i < n && text[i] !== '\n') { out += ' '; i += 1; }
      continue;
    }
    if (c === '/' && d === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) { out += text[i] === '\n' ? '\n' : ' '; i += 1; }
      if (i < n) { out += '  '; i += 2; }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const triple = c !== '`' && text.startsWith(c.repeat(3), i);
      const close = triple ? c.repeat(3) : c;
      const raw = stack === 'dart' && text[i - 1] === 'r' && !/\w/.test(text[i - 2] || '');
      out += close;
      i += close.length;
      while (i < n) {
        if (!raw && text[i] === '\\') {
          out += ' ';
          i += 1;
          if (i < n) { out += text[i] === '\n' ? '\n' : ' '; i += 1; }
          continue;
        }
        if (text.startsWith(close, i)) { out += close; i += close.length; break; }
        // an unterminated one-line string (an apostrophe in JSX text) ends at the newline
        if (!triple && c !== '`' && text[i] === '\n') {break;}
        out += text[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

const CONTROL_WORDS = new Set(['if', 'switch', 'catch', 'when', 'synchronized', 'using', 'guard', 'with', 'return', 'assert', 'super', 'this']);
const LOOP_CALL = /\.(forEach|map|expand|forEachIndexed|onEach|asyncMap|flatMap|forIn)\s*\(\s*$/;

// Finds the `(` matching the `)` that ends `s`; -1 when it is not in `s`.
function matchingParen(s) {
  let depth = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i] === ')') {depth += 1;}
    else if (s[i] === '(') {
      depth -= 1;
      if (depth === 0) {return i;}
    }
  }
  return -1;
}

// What a `{` opens, from the code before it (back to the previous ; { or }).
function classifyHeader(header) {
  const h = header.trim();
  const out = { kind: 'block', loop: false, build: false };
  if (/=>\s*$/.test(h)) { out.kind = 'function'; return out; }
  if (/(^|[\s)])do$/.test(h)) { out.loop = true; return out; }
  if (/(^|[\s)])(else|try|finally|default|init|get|set|willSet|didSet|defer)$/.test(h) && !/\bget\s+\w+$/.test(h)) {return out;}
  if (/\b(class|mixin|extension|enum|interface|struct|protocol|object)\b[^()=]*$/.test(h)) { out.kind = 'class'; return out; }
  if (/(^|[\s;])for\s+\w+(\s*,\s*\w+)?\s+in\b/.test(h) || /(^|[\s;])(while|repeat)\b[^()]*$/.test(h)) { out.loop = true; return out; }
  if (/\.(forEach|map|onEach|forEachIndexed|flatMap)\s*$/.test(h)) { out.kind = 'function'; out.loop = true; return out; }
  if (/\bget\s+\w+$/.test(h)) { out.kind = 'function'; return out; }
  let s = h.replace(/\s*(async\*?|sync\*|throws|rethrows|const|override|mutating)\s*$/, '');
  s = s.replace(/\)\s*->\s*[^()]+$/, ')').replace(/\)\s*:\s*[\w<>?,.\s[\]]+$/, ')');
  if (!s.endsWith(')')) {return out;}
  const open = matchingParen(s);
  if (open < 0) { out.kind = 'function'; return out; }
  const before = s.slice(0, open);
  const word = (/(\w+)\s*$/.exec(before) || [])[1];
  if (word === 'for' || word === 'while') { out.loop = true; return out; }
  if (word && CONTROL_WORDS.has(word)) {return out;}
  out.kind = 'function';
  if (LOOP_CALL.test(before)) {out.loop = true;}
  if (/\bWidget\s+build\s*$/.test(before) && /BuildContext/.test(s.slice(open))) {out.build = true;}
  out.builder = /(builder|Builder)\s*[:(]\s*$/.test(before) || /\b(itemBuilder|builder|separatorBuilder)\s*:\s*$/.test(before);
  out.handler = /\bon[A-Z]\w*\s*[:=]\s*$/.test(before) || /\b(listener|addListener|then|listen)\s*[:(]\s*$/.test(before);
  return out;
}

// Every `{ ... }` in the blanked code: { start, end, header, kind, loop, build }.
// Line indexes are 0-based.
function buildSpans(codeLines) {
  const spans = [];
  const stack = [];
  let buf = '';
  for (let li = 0; li < codeLines.length; li++) {
    const line = codeLines[li];
    for (let ci = 0; ci < line.length; ci++) {
      const ch = line[ci];
      if (ch === '{') {
        const header = buf.slice(-400).replace(/\s+/g, ' ').trim();
        const span = { start: li, end: codeLines.length - 1, header, ...classifyHeader(header) };
        spans.push(span);
        stack.push(span);
        buf = '';
      } else if (ch === '}') {
        const s = stack.pop();
        if (s) {s.end = li;}
        buf = '';
      } else if (ch === ';') {
        buf = '';
      } else {
        buf += ch;
      }
    }
    buf += ' ';
  }
  return spans;
}

// Spans whose body holds line li (0-based), innermost first.
function enclosing(spans, li) {
  return spans.filter(s => s.start < li && li <= s.end).sort((a, b) => b.start - a.start);
}

function innermostFunction(spans, li) {
  return enclosing(spans, li).find(s => s.kind === 'function') || null;
}

// True when line li runs as part of build(): inside build() itself or a
// builder closure in it, but not inside an event handler closure.
function inBuild(spans, li) {
  for (const s of enclosing(spans, li)) {
    if (s.kind !== 'function') {continue;}
    if (s.build) {return true;}
    if (s.builder) {continue;}
    return false;
  }
  return false;
}

// Inside a loop body before leaving the nearest plain function.
function inLoop(spans, li) {
  for (const s of enclosing(spans, li)) {
    if (s.loop) {return true;}
    if (s.kind === 'function') {return false;}
  }
  return false;
}

// --- glob and import resolution ----------------------------------------------------

function hasGlob(s) {
  return /[*?{]/.test(s);
}

// `**` any depth, `*` one segment, `?` one char, `{a,b}` alternatives.
function globToRegex(glob) {
  let re = '';
  let braces = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') { i += 1; re += '(?:.*/)?'; } else {re += '.*';}
      } else {re += '[^/]*';}
    } else if (c === '?') {re += '[^/]';}
    else if (c === '{') { braces += 1; re += '(?:'; }
    else if (c === '}' && braces) { braces -= 1; re += ')'; }
    else if (c === ',' && braces) {re += '|';}
    else {re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');}
  }
  return new RegExp(`^${re}$`);
}

function globMatch(glob, p) {
  return globToRegex(glob).test(p);
}

// The specifier an import/export/require line names, or null.
function importSpec(text, stack) {
  if (stack === 'dart') {
    const m = /^\s*(?:import|export|part)\s+['"]([^'"]+)['"]/.exec(text);
    return m ? m[1] : null;
  }
  if (stack === 'js') {
    const m = /^\s*(?:import|export)\b[^'"]*?\bfrom\s+['"]([^'"]+)['"]/.exec(text) ||
      /^\s*import\s+['"]([^'"]+)['"]/.exec(text) ||
      /\brequire\(\s*['"]([^'"]+)['"]\s*\)/.exec(text) ||
      /\bimport\(\s*['"]([^'"]+)['"]\s*\)/.exec(text);
    return m ? m[1] : null;
  }
  if (stack === 'jvm' || stack === 'swift') {
    const m = /^\s*import\s+(?:static\s+)?([\w.]+)/.exec(text);
    return m ? m[1] : null;
  }
  return null;
}

// Repo-relative path an import points at, or the specifier itself when it
// names another package. `packages` maps a pubspec dir to its package name.
function resolveImport(spec, fromFile, packages) {
  if (!spec) {return spec;}
  const pkg = /^package:([^/]+)\/(.*)$/.exec(spec);
  if (pkg) {
    const own = (packages || []).find(p => p.name === pkg[1]);
    if (!own) {return spec;}
    return path.posix.normalize(path.posix.join(own.dir, 'lib', pkg[2]));
  }
  if (spec.startsWith('./') || spec.startsWith('../') || (!/^[a-z]+:/.test(spec) && /\.dart$/.test(spec) && !spec.startsWith('/'))) {
    return path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  }
  return spec;
}

function importForbidden(entry, spec, resolved) {
  if (hasGlob(entry)) {return globMatch(entry, resolved) || globMatch(entry, spec);}
  return resolved.includes(entry) || spec.includes(entry);
}

// Default layer rules for a <src>/features/<f>/{data,domain,presentation} layout.
function defaultLayers(layout) {
  const src = layout.src;
  const f = `${src}/features`;
  const framework = layout.stack === 'dart'
    ? ['package:flutter/', 'package:dio/', 'package:http/', 'package:flutter_bloc/', 'package:get_it/']
    : ['react{,/**}', 'react-native{,/**}', 'axios{,/**}'];
  return [
    {
      name: 'domain-framework-free',
      files: `${f}/*/domain/**`,
      mustNotImport: [`${f}/*/data/**`, `${f}/*/presentation/**`, ...framework],
      why: 'domain must stay framework-free: no data, presentation, Flutter/UI or HTTP client imports.',
    },
    {
      name: 'presentation-not-data',
      files: `${f}/*/presentation/**`,
      mustNotImport: [`${f}/*/data/**`],
      why: 'presentation should go through domain (use cases or a repository interface), not data.',
    },
    { name: 'no-cross-feature-internals', crossFeature: true, src,
      why: 'cross-feature coupling: expose it via the other feature\'s domain or a shared module.' },
    {
      name: 'data-not-presentation',
      files: `${f}/*/data/**`,
      mustNotImport: [`${f}/*/presentation/**`],
      why: 'data must not depend on presentation.',
    },
  ];
}

// The layer rules an import breaks: [{ name, why }].
function layerViolations(file, spec, resolved, layers) {
  const out = [];
  for (const layer of layers) {
    if (layer.crossFeature) {
      const esc = layer.src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const from = new RegExp(`^${esc}/features/([^/]+)/`).exec(file);
      const to = new RegExp(`^${esc}/features/([^/]+)/(data|presentation)/`).exec(resolved);
      if (from && to && from[1] !== to[1]) {out.push({ name: layer.name, why: layer.why });}
      continue;
    }
    if (!layer.files || !globMatch(layer.files, file)) {continue;}
    const bad = (layer.mustNotImport || []).find(e => importForbidden(e, spec, resolved));
    if (bad) {out.push({ name: layer.name, why: `${layer.why || 'layer rule'} (matches "${bad}")` });}
  }
  return out;
}

// --- secrets ---------------------------------------------------------------------

const KNOWN_SECRET = /(AIza[0-9A-Za-z_-]{35}|sk_(?:live|test)_[0-9A-Za-z]{16,}|gh[pousr]_[0-9A-Za-z]{36}|xox[abprs]-[0-9A-Za-z-]{10,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]+)/;
const PLACEHOLDER = /^(\$\{|\$\(|%|<|your|xxx|todo|changeme|placeholder|example|dummy|fake|sample|null|none|undefined|true|false|string)/i;

// Literal values on the line that look like credentials: [{ value, why }].
function secretCandidates(text, prevText) {
  const found = [];
  const add = (name, value) => {
    if (!value || found.some(f => f.value === value)) {return;}
    const v = value.trim();
    if (PLACEHOLDER.test(v) || v.includes('${') || /\s/.test(v) || /:\/\//.test(v)) {return;}
    const cls = name ? keyClass(name) : null;
    if (cls === 'strong' && v.length >= 8 && (looksSecret(v) || (/\d/.test(v) && /[A-Za-z]/.test(v)))) {
      found.push({ value: v, name });
    } else if (cls === 'weak' && looksSecret(v)) {
      found.push({ value: v, name });
    }
  };
  const pair = /["']?([A-Za-z_][\w.-]*)["']?\s*(?::|=|=>|:=)\s*(?:const\s+|r)?["']([^"'\n]{6,})["']/g;
  let m;
  while ((m = pair.exec(text))) {add(m[1], m[2]);}
  const bare = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*[:=]\s*([^\s'"#,;]{8,})\s*$/.exec(text);
  if (bare) {add(bare[1], bare[2]);}
  const attr = /android:name="([^"]+)"[^>]*android:value="([^"]+)"/.exec(text);
  if (attr) {add(attr[1], attr[2]);}
  const xml = /name="([^"]+)"[^>]*>([^<]{8,})</.exec(text);
  if (xml) {add(xml[1], xml[2]);}
  const plistValue = /<string>([^<]+)<\/string>/.exec(text);
  const plistKey = prevText && /<key>([^<]+)<\/key>/.exec(prevText);
  if (plistValue && plistKey) {add(plistKey[1], plistValue[1]);}
  const known = new RegExp(KNOWN_SECRET.source, 'g');
  while ((m = known.exec(text))) {
    if (!found.some(f => f.value.includes(m[1]))) {found.push({ value: m[1], name: null });}
  }
  return found;
}

// Masks every secret-looking literal in a line before it is printed.
function maskSecrets(text, extra) {
  let out = String(text);
  for (const v of extra || []) {out = out.split(v).join(maskValue(v));}
  out = out.replace(new RegExp(KNOWN_SECRET.source, 'g'), s => maskValue(s));
  out = out.replace(/(["'])([^"'\n]{16,})\1/g, (all, q, s) => (looksSecret(s) ? `${q}${maskValue(s)}${q}` : all));
  out = out.replace(/(?<![\w/.-])[A-Za-z0-9_+=-]{20,}(?![\w/.-])/g, s => (looksSecret(s) && /\d/.test(s) && /[A-Za-z]/.test(s) ? maskValue(s) : s));
  return out;
}

// --- context the rules share ----------------------------------------------------------

const SENSITIVE = /(token|password|passwd|authorization|bearer|cookie|otp|cvv|card|secret|session)/i;
const STORAGE_SENSITIVE = /(token|password|passwd|secret|session|card|refresh|cvv|otp|pin\b)/i;
const CONTEXT_USE = /\b(Navigator\.(?:of|pop|push\w*|maybePop)\s*\(\s*context\b|context\s*\.\s*(?:push\w*|go\w*|pop|read|watch|replace|router|l10n|tr|showSnackBar|navigator)\b|ScaffoldMessenger\.of\(\s*context|show(?:Dialog|ModalBottomSheet|CupertinoDialog|GeneralDialog|BottomSheet|DatePicker|TimePicker)\s*[(<]|Theme\.of\(\s*context|MediaQuery\.of\(\s*context|BlocProvider\.of\s*<[^>]*>\s*\(\s*context|GoRouter\.of\(\s*context|AutoRouter\.of\(\s*context|\w+\.of\(\s*context\s*\)\s*\.\s*(?:push|pop|show)\w*)/;
const BLOC_EVENT = /(Search|Query|Typed|Changed|LoadMore|Fetch|Refresh|Scroll|Filter|Sort)/;
const CONTROLLERS = '(AnimationController|TextEditingController|ScrollController|PageController|TabController|FocusNode|StreamController|Timer\\.periodic|VideoPlayerController|ValueNotifier|ChangeNotifier)';
const CONTROLLER_NEW = new RegExp(`\\b${CONTROLLERS}(?:\\s*<[^>]*>)?(?:\\.\\w+)?\\s*\\(`);
const CONTROLLER_FIELD = new RegExp(`(?:^|[\\s(,;])(?:late\\s+)?(?:(?:final|var)\\s+)?(?:[\\w<>?]+\\s+)?(_?\\w+)\\s*=\\s*(?:new\\s+)?${CONTROLLERS}(?:\\s*<[^>]*>)?(?:\\.\\w+)?\\s*\\(`);
const PRESENTATION_PATH = /(^|\/)(presentation|widgets?|screens?|pages?|views?|ui|components)\//;

function lineAt(ctx, n) {
  return ctx.lines[n - 1] || '';
}

function codeAt(ctx, n) {
  return ctx.code[n - 1] || '';
}

// Text from line n until its parentheses balance (at most `max` lines).
function callText(ctx, n, max = 15) {
  let depth = 0;
  let opened = false;
  let out = '';
  for (let i = n; i < n + max && i <= ctx.lines.length; i++) {
    out += `${lineAt(ctx, i)}\n`;
    for (const ch of codeAt(ctx, i)) {
      if (ch === '(') { depth += 1; opened = true; }
      else if (ch === ')') {depth -= 1;}
    }
    if (opened && depth <= 0) {break;}
  }
  return out;
}

function nextLines(ctx, n, count) {
  return ctx.lines.slice(n - 1, n - 1 + count).join('\n');
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function manifestSection(ctx, n) {
  if (ctx.stack === 'pubspec') {
    for (let i = n; i >= 1; i--) {
      const m = /^([A-Za-z_]\w*):/.exec(lineAt(ctx, i));
      if (m) {return m[1];}
    }
    return null;
  }
  if (ctx.stack === 'package-json') {
    for (let i = n; i >= 1; i--) {
      const t = lineAt(ctx, i);
      const m = /^\s{0,4}"(\w+)"\s*:\s*\{/.exec(t);
      if (m) {return m[1];}
      if (i < n && /^\s{0,4}\}/.test(t)) {return null;}
    }
  }
  return null;
}

// --- rules -------------------------------------------------------------------------
//
// Each rule: id, dimension, severity (hint for when it is confirmed), stacks
// ('*' for every scanned file) and either
//   line(text, ctx, n)  -> falsy | true | { why, text, severity, mask }
//   file(ctx)           -> [{ line, why?, text?, severity? }]  (added lines only are kept)
// plus `why`, the one line printed under the lead.

const RULES = [
  // ---------------------------------------------------------------- owasp
  {
    id: 'hardcoded-secret', dimension: 'owasp', severity: 'red', stacks: '*', tests: true,
    why: 'M1 Improper Credential Usage: a credential in source ships in every build and in git history. Move it to a secret store or build-time env, and rotate it if it was ever real.',
    line(text, ctx, n) {
      const found = secretCandidates(text, lineAt(ctx, n - 1));
      if (!found.length) {return null;}
      const names = found.map(f => f.name).filter(Boolean);
      return {
        mask: found.map(f => f.value),
        severity: ctx.isTest ? 'yellow' : 'red',
        why: `${ctx.isTest ? 'In a test file: confirm it is a made-up fixture value. ' : ''}${this.why}${names.length ? ` (key: ${names.join(', ')})` : ''}`,
      };
    },
  },
  {
    id: 'cleartext-http', dimension: 'owasp', severity: 'yellow', stacks: [...CODE, 'android-manifest', 'plist', 'netsec', 'gradle', 'config'],
    why: 'M5 Insecure Communication: plain http can be read and altered on the network. Use https, or confirm this host is local/dev only.',
    line(text) {
      if (/xmlns/.test(text)) {return null;}
      const re = /http:\/\/([^\s'"`<>)\]/:]+)/g;
      let m;
      while ((m = re.exec(text))) {
        const host = m[1].toLowerCase();
        if (/^(localhost|127\.0\.0\.1|10\.0\.2\.2|0\.0\.0\.0|\[::1\])$/.test(host)) {continue;}
        if (/^(schemas\.android\.com|www\.w3\.org|schemas\.microsoft\.com|ns\.adobe\.com|www\.apple\.com|apple\.com|purl\.org|schemas\.xmlsoap\.org|json-schema\.org)$/.test(host)) {continue;}
        return true;
      }
      return null;
    },
  },
  {
    id: 'tls-bypass', dimension: 'owasp', severity: 'red', stacks: [...CODE, 'android-manifest', 'plist', 'netsec', 'config'],
    why: 'M5 Insecure Communication: certificate or cleartext checks are switched off, so a proxy on the network can read and change traffic. Confirm it is debug-only and cannot ship.',
    line(text, ctx, n) {
      if (/badCertificateCallback|onBadCertificate|HostnameVerifier|ALLOW_ALL_HOSTNAME_VERIFIER|trustAllCerts|NODE_TLS_REJECT_UNAUTHORIZED|setHostnameVerifier/.test(text)) {return true;}
      if (/usesCleartextTraffic\s*=\s*"true"|cleartextTrafficPermitted\s*=\s*"true"|rejectUnauthorized\s*:\s*false|NSExceptionAllowsInsecureHTTPLoads/.test(text)) {return true;}
      if (/NSAllowsArbitraryLoads/.test(text) && /<true\s*\/>/.test(`${text}\n${lineAt(ctx, n + 1)}`)) {return true;}
      if (/checkServerTrusted/.test(text) && (/\{\s*\}/.test(text) || /^\s*\}/.test(lineAt(ctx, n + 1)))) {return true;}
      return null;
    },
  },
  {
    id: 'sensitive-log', dimension: 'owasp', severity: 'yellow', stacks: CODE,
    why: 'M6 Inadequate Privacy Controls / M9: logs end up in logcat, crash reports and device backups. Do not log tokens, credentials, card data or session ids, even in debug builds.',
    line(text) {
      const m = /(?:^|[^\w.])(print|debugPrint|log|developer\.log|console\.(?:log|debug|info|warn|error)|Log\.[dviwe]|NSLog|os_log|logger\.\w+|Logger\.\w+|_logger\.\w+|printf|println|Timber\.\w)\s*\(/.exec(text);
      if (!m) {return null;}
      return SENSITIVE.test(text.slice(m.index + m[0].length)) ? true : null;
    },
  },
  {
    id: 'insecure-storage', dimension: 'owasp', severity: 'yellow', stacks: CODE,
    why: 'M9 Insecure Data Storage: plain key-value storage is readable on a rooted/jailbroken device and in backups. Use flutter_secure_storage / Keychain / EncryptedSharedPreferences for secrets.',
    line(text) {
      if (/secure/i.test(text)) {return null;}
      const m = /\b(?:\w*prefs?\w*|\w*[Pp]references\w*|AsyncStorage|UserDefaults(?:\.standard)?|localStorage|sessionStorage|\w*[Ss]torage|\w*[Bb]ox|Hive\.box\([^)]*\)|editor|edit\(\))\s*[?!]?\.\s*(?:set(?:String|Bool|Int|Double|StringList|Item|Value|Object)?|put(?:String|Boolean|Int|Long)?|write)\s*\(/.exec(text);
      if (!m) {return null;}
      return STORAGE_SENSITIVE.test(text.slice(m.index)) ? true : null;
    },
  },
  {
    id: 'webview-risk', dimension: 'owasp', severity: 'yellow', stacks: CODE,
    why: 'M4 Insufficient Input/Output Validation: JavaScript, a JS bridge or file access in a WebView lets any page it loads run code against the app. Restrict navigation to trusted origins.',
    line(text) {
      return /JavaScriptMode\.unrestricted|setJavaScriptEnabled\s*\(\s*true|addJavascriptInterface|javaScriptEnabled\s*[:=]\s*\{?\s*true|allowFileAccess(?:FromFileURLs)?\s*[:=]\s*\{?\s*true|setAllowFileAccess\s*\(\s*true|setAllowUniversalAccessFromFileURLs\s*\(\s*true|allowUniversalAccessFromFileURLs\s*[:=]\s*\{?\s*true/.test(text) ? true : null;
    },
  },
  {
    id: 'exported-component', dimension: 'owasp', severity: 'yellow', stacks: ['android-manifest'],
    why: 'M8 Security Misconfiguration: an exported component can be started by any app; debuggable or allowBackup exposes app data. The launcher activity must be exported; anything else needs a permission or strict intent validation.',
    line(text) {
      if (/android:debuggable\s*=\s*"true"/.test(text)) {return { severity: 'red' };}
      return /android:(exported|allowBackup)\s*=\s*"true"/.test(text) ? true : null;
    },
  },
  {
    id: 'weak-crypto', dimension: 'owasp', severity: 'yellow', stacks: CODE,
    why: 'M10 Insufficient Cryptography: MD5/SHA1, ECB mode and non-secure Random are not safe for anything security relevant (tokens, nonces, passwords, signatures). Use SHA256 or stronger, AES-GCM and Random.secure()/SecureRandom/crypto.',
    line(text) {
      if (/\bmd5\.convert|\bsha1\.convert|MessageDigest\.getInstance\(\s*["'](?:MD5|SHA-?1)["']|createHash\(\s*['"](?:md5|sha1)['"]|CC_MD5|CC_SHA1\b|Insecure\.(?:MD5|SHA1)|\/ECB\/|AESMode\.ecb|\bmode\.ECB\b/.test(text)) {return true;}
      if (/\bRandom\(\s*\)|Math\.random\(\)/.test(text) && /(token|nonce|otp|password|salt|secret|\biv\b|key\b|uuid)/i.test(text)) {return true;}
      return null;
    },
  },
  {
    id: 'deeplink-input', dimension: 'owasp', severity: 'yellow', stacks: ['dart', 'js', 'jvm', 'swift'],
    why: 'M4 Insufficient Input/Output Validation: a deep-link parameter flows into a URL, network call or WebView in the same change. Validate or allowlist it before use (open redirect, request forgery, phishing in a WebView).',
    file(ctx) {
      const SOURCE = /uri\.queryParameters|\.pathSegments\b|state\.uri|\.pathParameters|getQueryParameter|Linking\.getInitialURL|route\.params|queryParametersAll|\.queryParameters\[/;
      const SINK = /launchUrl|launchUrlString|\blaunch\(|loadRequest|loadUrl|initialUrl|WebUri\(|URLRequest\(|\bdio\.|\.get\(|\.post\(|\bhttp\.\w+\(|fetch\(|Linking\.openURL|openURL|Uri\.parse\(|Uri\.https?\(/;
      const out = [];
      const byHunk = new Map();
      for (const a of ctx.addedList) {
        if (!byHunk.has(a.hunk)) {byHunk.set(a.hunk, []);}
        byHunk.get(a.hunk).push(a);
      }
      for (const rows of byHunk.values()) {
        const src = rows.find(r => SOURCE.test(r.text));
        if (!src) {continue;}
        if (rows.some(r => r.line >= src.line && SINK.test(r.text))) {out.push({ line: src.line });}
      }
      return out;
    },
  },
  {
    id: 'dependency-change', dimension: 'owasp', severity: 'yellow', stacks: ['pubspec', 'package-json', 'gradle'],
    why: 'M2 Inadequate Supply Chain Security: new or bumped dependency. Check its advisories and maintenance (flutter pub outdated, npm audit, osv-scanner on the lockfile).',
    line(text, ctx, n) {
      if (ctx.stack === 'gradle') {
        return /^\s*(implementation|api|kapt|ksp|classpath|compileOnly|runtimeOnly|annotationProcessor|coreLibraryDesugaring)\s*[( ]\s*['"]/.test(text) ? true : null;
      }
      const section = manifestSection(ctx, n);
      if (ctx.stack === 'pubspec') {
        if (!/^(dependencies|dev_dependencies|dependency_overrides)$/.test(section || '')) {return null;}
        const m = /^\s{2}([A-Za-z_][\w]*):\s*(.*)$/.exec(text);
        if (!m || /^(sdk|flutter)$/.test(m[1]) && /sdk/.test(lineAt(ctx, n + 1) + m[2])) {return null;}
        return { why: `${this.why} (${m[1]}${m[2] ? ` ${m[2].trim()}` : ''})` };
      }
      if (!/^(dependencies|devDependencies|peerDependencies|optionalDependencies|resolutions|overrides)$/.test(section || '')) {return null;}
      const m = /^\s*"([^"]+)"\s*:\s*"([^"]*)"/.exec(text);
      return m ? { why: `${this.why} (${m[1]} ${m[2]})` } : null;
    },
  },

  // ---------------------------------------------------------------- perf
  {
    id: 'non-lazy-list', dimension: 'perf', severity: 'yellow', stacks: ['dart'],
    why: 'Builds every child up front, even off screen. For a dynamic or long list use ListView.builder / GridView.builder / SliverList.',
    line(text, ctx, n) {
      const code = codeAt(ctx, n);
      const ahead = nextLines(ctx, n, 12);
      const dynamic = /\.map\s*\(|List\.generate|\bfor\s*\(|\.\.\.\w/;
      if (/\b(ListView|GridView)\s*\(/.test(code) && dynamic.test(ahead)) {return true;}
      if (/\bSingleChildScrollView\s*\(/.test(code)) {
        const near = nextLines(ctx, n, 8);
        if (/\b(Column|Row|Wrap)\s*\(/.test(near) && dynamic.test(near)) {return true;}
      }
      return null;
    },
  },
  {
    id: 'shrinkwrap-in-scroll', dimension: 'perf', severity: 'yellow', stacks: ['dart'],
    why: 'shrinkWrap: true lays out every child to measure the list, so it is no longer lazy. Prefer slivers (CustomScrollView) for a list inside a scroll view.',
    line(_text, ctx, n) {
      return /shrinkWrap\s*:\s*true/.test(codeAt(ctx, n)) ? true : null;
    },
  },
  {
    id: 'work-in-build', dimension: 'perf', severity: 'yellow', stacks: ['dart'],
    why: 'Runs on every rebuild (and build() can run every frame during an animation). Move parsing, sorting, formatters and async work to initState, the bloc/notifier or a memoised value.',
    file(ctx) {
      const re = /jsonDecode\(|json\.decode\(|\.sort\(|RegExp\(|DateFormat\(|NumberFormat\(|\bawait\b|Future\.\w+\(|\bhttp\.\w+\(|\bdio\.\w+\(|\.then\(|File\(|readAsString|compute\(/;
      const out = [];
      for (const a of ctx.addedList) {
        const code = codeAt(ctx, a.line);
        if (re.test(code) && inBuild(ctx.spans, a.line - 1)) {out.push({ line: a.line });}
      }
      return out;
    },
  },
  {
    id: 'request-in-loop', dimension: 'perf', severity: 'yellow', stacks: ['dart', 'js'],
    why: 'An awaited call inside a loop runs one request per item, one after another (N+1). Batch it, or run them together with Future.wait / Promise.all if order does not matter.',
    file(ctx) {
      const call = /\bawait\s+(?!Future\.(?:delayed|wait)\b|Promise\.all\b|sleep\b|new\s+Promise\b)[\w.?!<>[\]]+\s*\(/;
      const out = [];
      for (const a of ctx.addedList) {
        const code = codeAt(ctx, a.line);
        if (!call.test(code)) {continue;}
        if (/\.(map|forEach)\s*\(.*\bawait\b/.test(code) || inLoop(ctx.spans, a.line - 1)) {out.push({ line: a.line });}
      }
      return out;
    },
  },
  {
    id: 'image-no-cache-size', dimension: 'perf', severity: 'yellow', stacks: ['dart'],
    why: 'A network image is decoded at full resolution into memory. Pass cacheWidth/cacheHeight (or memCacheWidth for CachedNetworkImage) sized to the widget.',
    line(text, ctx, n) {
      if (!/\b(Image\.network|NetworkImage|CachedNetworkImage|CachedNetworkImageProvider)\s*\(/.test(codeAt(ctx, n))) {return null;}
      return /cacheWidth|cacheHeight|memCacheWidth|memCacheHeight|ResizeImage|maxWidthDiskCache/.test(callText(ctx, n, 15)) ? null : true;
    },
  },
  {
    id: 'setstate-in-loop', dimension: 'perf', severity: 'yellow', stacks: ['dart'],
    why: 'setState in a loop or a scroll/animation listener rebuilds on every iteration or tick. Update once, compare with the previous value first, or use a ValueListenableBuilder.',
    file(ctx) {
      const out = [];
      for (const a of ctx.addedList) {
        const code = codeAt(ctx, a.line);
        if (!/\bsetState\s*\(/.test(code)) {continue;}
        if (/addListener\s*\(.*setState/.test(code)) { out.push({ line: a.line }); continue; }
        const fn = innermostFunction(ctx.spans, a.line - 1);
        if ((fn && /addListener\s*\(\s*\(\s*\)$/.test(fn.header.replace(/\s*async$/, ''))) || inLoop(ctx.spans, a.line - 1)) {out.push({ line: a.line });}
      }
      return out;
    },
  },

  // ---------------------------------------------------------------- memory
  {
    id: 'unclosed-subscription', dimension: 'memory', severity: 'yellow', stacks: ['dart'],
    why: 'A stream subscription that is never cancelled keeps its listener (and whatever it captures) alive after the screen or bloc is gone, and keeps firing. Cancel it in dispose()/close().',
    file(ctx) {
      const out = [];
      const all = ctx.content;
      for (const a of ctx.addedList) {
        const code = codeAt(ctx, a.line);
        if (!/\.listen\s*\(/.test(code) || /\bref\.listen\s*\(/.test(code)) {continue;}
        // the statement may start a few lines up: `final sub = stream\n  .map(f)\n  .listen(g);`
        const stmt = ctx.code.slice(Math.max(0, a.line - 6), a.line).join('\n').split(/[;{}]/).pop();
        const v = /(?:^|[\s(,;])(_?\w+)\s*=\s*[^=;]*\.listen\s*\(/.exec(stmt);
        if (/\.add\s*\([^;]*\.listen\s*\(/.test(stmt) && /\.cancel\b/.test(all)) {continue;}
        if (v) {
          if (new RegExp(`\\b${escapeRe(v[1])}\\s*[?!]?\\s*\\.\\s*cancel\\b`).test(all)) {continue;}
          out.push({ line: a.line, why: `${this.why} (\`${v[1]}\` is never cancelled in this file)` });
        } else if (!/\.cancel\b/.test(all)) {
          out.push({ line: a.line, why: `${this.why} (the subscription is not kept, so it cannot be cancelled)` });
        }
      }
      return out;
    },
  },
  {
    id: 'undisposed-controller', dimension: 'memory', severity: 'yellow', stacks: ['dart'],
    why: 'A controller, focus node, stream controller or timer holds resources and listeners until disposed. Dispose/close/cancel it in dispose().',
    file(ctx) {
      const out = [];
      for (const a of ctx.addedList) {
        const code = codeAt(ctx, a.line);
        const kind = CONTROLLER_NEW.exec(code);
        if (!kind) {continue;}
        const field = CONTROLLER_FIELD.exec(code);
        if (field) {
          const name = escapeRe(field[1]);
          const released = new RegExp(`\\b${name}\\s*[?!]?\\s*(?:\\.|\\.\\.)\\s*(dispose|close|cancel)\\s*\\(`).test(ctx.content) ||
            new RegExp(`\\b${name}\\s*[?!]?\\s*\\)\\s*\\.\\.\\s*(dispose|close|cancel)`).test(ctx.content);
          if (!released) {out.push({ line: a.line, why: `${this.why} (\`${field[1]}\` has no dispose/close/cancel in this file)` });}
        } else if (inBuild(ctx.spans, a.line - 1)) {
          out.push({ line: a.line, why: `${kind[1]} created inline in build(): a new one on every rebuild, and none is disposed. Create it in initState and dispose it.` });
        } else if (kind[1] === 'Timer.periodic' && !/\.cancel\s*\(/.test(ctx.content)) {
          out.push({ line: a.line, why: 'Timer.periodic is not kept and nothing in this file cancels a timer: it keeps firing after the screen is gone.' });
        }
      }
      return out;
    },
  },
  {
    id: 'listener-not-removed', dimension: 'memory', severity: 'yellow', stacks: ['dart', 'js', 'jvm', 'swift'],
    why: 'A listener or observer registered here is never removed in this file, so it outlives its owner (leak, and callbacks on a disposed object).',
    file(ctx) {
      const out = [];
      const all = ctx.content;
      const PAIRS = [
        [/\b(_?\w+)\s*[?!]?\.addListener\s*\(/, /removeListener\s*\(/, 'dart'],
        [/\baddObserver\s*\(/, /removeObserver\s*\(/],
        [/\bAppState\.addEventListener\s*\(/, /\.remove\s*\(\s*\)/],
        [/\bKeyboard\.addListener\s*\(/, /\.remove\s*\(\s*\)|removeAllListeners|removeListener/],
        [/\baddEventListener\s*\(/, /removeEventListener\s*\(|\.remove\s*\(\s*\)|AbortController/],
        [/\bsetInterval\s*\(/, /clearInterval\s*\(/],
      ];
      for (const a of ctx.addedList) {
        const code = codeAt(ctx, a.line);
        for (const [add, remove, only] of PAIRS) {
          const m = add.exec(code);
          if (!m || (only && only !== ctx.stack)) {continue;}
          if (remove.test(all)) {break;}
          // a listener on a controller this file creates and disposes dies with it
          if (only === 'dart' && m[1]) {
            const owner = escapeRe(m[1]);
            const owned = new RegExp(`\\b${owner}\\s*=\\s*(?:new\\s+)?\\w*(Controller|FocusNode|Notifier)\\b`).test(all) &&
              new RegExp(`\\b${owner}\\s*[?!]?\\.\\s*dispose\\s*\\(`).test(all);
            if (owned) {break;}
          }
          out.push({ line: a.line });
          break;
        }
      }
      return out;
    },
  },
  {
    id: 'global-cache-growth', dimension: 'memory', severity: 'yellow', stacks: ['dart', 'js'],
    why: 'Unbounded cache: a static/module-level collection that is added to but never evicted grows for the whole app session. Add a size limit, eviction, or clear it on logout.',
    file(ctx) {
      const out = [];
      for (const a of ctx.addedList) {
        const code = codeAt(ctx, a.line);
        const dart = ctx.stack === 'dart' && (/^\s*static\s+(?!const\b)(?:final\s+)?[\w<>,?\s]*?\b(_?\w+)\s*=\s*(?:<[^>]*>\s*)?(?:\{\s*\}|\[\s*\]|\w*(?:Map|Set|List)\s*(?:<[^>]*>)?\s*\(\s*\))/.exec(code) ||
          /^(?:final|var)\s+[\w<>,?\s]*?\b(_?\w+)\s*=\s*(?:<[^>]*>\s*)?(?:\{\s*\}|\[\s*\]|\w*(?:Map|Set)\s*(?:<[^>]*>)?\s*\(\s*\))/.exec(code));
        const js = ctx.stack === 'js' && /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::[^=]+)?=\s*(?:new\s+(?:Map|Set)\s*(?:<[^>]*>)?\s*\(\s*\)|\[\s*\]|\{\s*\})/.exec(code);
        const m = dart || js;
        if (!m) {continue;}
        const name = escapeRe(m[1]);
        const grows = new RegExp(`\\b${name}\\s*(?:\\.\\s*(?:add|addAll|set|putIfAbsent|push|update)\\s*\\(|\\[[^\\]]+\\]\\s*=[^=])`).test(ctx.content);
        const shrinks = new RegExp(`\\b${name}\\s*(?:\\.\\s*(?:remove\\w*|clear|delete|pop|shift|splice|evict\\w*)\\s*\\(|\\s*=\\s*(?:\\{\\}|\\[\\]|new ))`).test(ctx.content.replace(code, ''));
        if (grows && !shrinks) {out.push({ line: a.line });}
      }
      return out;
    },
  },
  {
    id: 'closure-captures-context', dimension: 'memory', severity: 'yellow', stacks: ['dart'],
    why: 'A stored BuildContext outlives its widget: using it later hits a deactivated element, and it keeps the element tree alive. Pass context per call, or keep what you need (a navigator, a theme value) instead.',
    file(ctx) {
      const out = [];
      for (const a of ctx.addedList) {
        const code = codeAt(ctx, a.line);
        if (/\b_?\w*[cC]ontext\w*\s*=\s*context\s*;/.test(code) && !/\bfinal\s+\w+\s+\w+\s*=/.test(code)) {
          out.push({ line: a.line });
          continue;
        }
        if (!/^\s*(?:late\s+)?(?:final\s+)?BuildContext\??\s+_?\w+\s*;/.test(code)) {continue;}
        const owner = enclosing(ctx.spans, a.line - 1).find(s => s.kind === 'class');
        if (owner && /\bextends\s+(StatelessWidget|StatefulWidget|State\s*<|\w*Widget\b|InheritedWidget)/.test(owner.header)) {continue;}
        out.push({ line: a.line });
      }
      return out;
    },
  },

  // ---------------------------------------------------------------- concurrency
  {
    id: 'context-after-await', dimension: 'concurrency', severity: 'red', stacks: ['dart'],
    why: 'BuildContext used after an await with no mounted check: if the user left the screen meanwhile this throws or acts on the wrong route. Add `if (!context.mounted) return;` after the await.',
    file(ctx) { return afterAwait(ctx, CONTEXT_USE); },
  },
  {
    id: 'setstate-after-await', dimension: 'concurrency', severity: 'red', stacks: ['dart'],
    why: 'setState after an await with no mounted check: throws "setState() called after dispose()" when the screen closed during the call. Check `if (!mounted) return;` first.',
    file(ctx) { return afterAwait(ctx, /\bsetState\s*\(/); },
  },
  {
    id: 'bloc-no-transformer', dimension: 'concurrency', severity: 'yellow', stacks: ['dart'],
    why: 'Bloc handlers are concurrent by default since bloc 8: two in-flight searches/refreshes can interleave and an older response can emit last. Consider restartable() / droppable() / sequential() from bloc_concurrency.',
    line(text, ctx, n) {
      const m = /\bon\s*<\s*(\w+)\s*>\s*\(/.exec(codeAt(ctx, n));
      if (!m || !BLOC_EVENT.test(m[1])) {return null;}
      return /transformer\s*:/.test(callText(ctx, n, 40)) ? null : { why: `${this.why} (event ${m[1]})` };
    },
  },
  {
    id: 'unawaited-future', dimension: 'concurrency', severity: 'yellow', stacks: ['dart', 'js'],
    why: 'A future that is neither awaited nor given an error handler: its error is unhandled and its timing is not tied to the caller. Await it, add catchError/.catch, or mark it unawaited() on purpose.',
    line(text, ctx, n) {
      const code = codeAt(ctx, n);
      if (/\bFuture\.delayed\s*\(/.test(code) && !/\b(await|return|unawaited|yield)\b|=\s*Future\.delayed|\.then\s*\(|=>\s*Future\.delayed/.test(code)) {return true;}
      if (/\.then\s*\(/.test(code) && !/\b(await|return)\b|=\s*[\w.]+\.then/.test(code)) {
        const ahead = nextLines(ctx, n, 4);
        if (!/catchError|onError|\.catch\s*\(|whenComplete|\.finally\s*\(/.test(ahead)) {return true;}
      }
      return null;
    },
  },
  {
    id: 'shared-mutable-static', dimension: 'concurrency', severity: 'yellow', stacks: ['dart', 'js', 'swift'],
    why: 'Mutable shared state: every screen, test and isolate-free async path sees and races on the same value, and it survives logout. Make it final/const, or own it in an injected object.',
    line(text, ctx, n) {
      const code = codeAt(ctx, n);
      if (ctx.stack === 'dart') {return /^\s*static\s+(?!final\b|const\b)(?:late\s+)?(?:[A-Za-z_][\w<>?,\s]*?\s+)?_?\w+\s*(=(?!=)|;)/.test(code) && !/\(/.test(code.split('=')[0]) ? true : null;}
      if (ctx.stack === 'js') {return /^(?:export\s+)?let\s+\w+/.test(code) ? true : null;}
      return /^\s*(?:(?:public|private|internal|fileprivate)\s+)?static\s+var\b/.test(code) ? true : null;
    },
  },
  {
    id: 'double-submit', dimension: 'concurrency', severity: 'yellow', stacks: ['dart', 'js'],
    why: 'The handler awaits work and the file has no busy/loading guard: can the user tap twice while it is in flight (double order, double payment)? Disable the button or ignore taps while busy.',
    line(text, ctx, n) {
      const code = codeAt(ctx, n);
      if (!/\bon(?:Pressed|Tap|Submit|Submitted|Click|Press|LongPress)\s*[:=]\s*\{?\s*(?:\(\s*[\w\s,]*\)|\w+)?\s*(?:async\b|=>)/.test(code)) {return null;}
      if (!/\bawait\b/.test(ctx.code.slice(n - 1, n + 7).join('\n'))) {return null;}
      return /(isSubmitting|isLoading|_loading|loading|_busy|isBusy|inProgress|isProcessing|submitting|isPending|_inFlight|isInProgress)/i.test(ctx.content) ? null : true;
    },
  },

  // ---------------------------------------------------------------- standards
  {
    id: 'debug-leftover', dimension: 'standards', severity: 'yellow', stacks: CODE,
    why: 'Debug output left in: it is noise in release logs and can leak data. Remove it or use the project logger behind a debug flag.',
    line(text, ctx, n) {
      const code = codeAt(ctx, n);
      return /^\s*(print|debugPrint)\s*\(|\bconsole\.(log|debug)\s*\(|\bdebugger\b|^\s*println\s*\(|^\s*NSLog\s*\(/.test(code) ? true : null;
    },
  },
  {
    id: 'todo-added', dimension: 'standards', severity: 'yellow', stacks: [...CODE, 'config', 'gradle', 'pubspec', 'android-manifest', 'plist'],
    why: 'New TODO/FIXME/HACK: is the unfinished part in scope for this ticket, and is there a follow-up ticket?',
    line(text) {
      return /(\/\/|\/\*|#|\*|<!--)\s*.*\b(TODO|FIXME|HACK|XXX)\b/.test(text) ? true : null;
    },
  },
  {
    id: 'lint-suppressed', dimension: 'standards', severity: 'yellow', stacks: CODE,
    why: 'A lint/type check is switched off here: confirm the reason is real and narrow (one rule, one line), not hiding a bug.',
    line(text) {
      return /\/\/\s*ignore(_for_file)?\s*:|eslint-disable|@ts-ignore|@ts-nocheck|@ts-expect-error|@Suppress(Warnings)?\s*\(|swiftlint:disable|\/\/\s*nolint|#\s*noqa/.test(text) ? true : null;
    },
  },
  {
    id: 'large-file', dimension: 'standards', severity: 'yellow', stacks: CODE,
    why: 'The file is past the size limit and this change pushed it over or grew it a lot: hard to review and usually more than one responsibility. Consider splitting it.',
    file(ctx) {
      const max = ctx.review.maxFileLines;
      const growth = ctx.addedList.length - ctx.removed;
      const before = ctx.lines.length - growth;
      // a few lines added to an already long file is not news; crossing the limit or a big jump is
      if (ctx.lines.length <= max || growth <= 0 || (before > max && growth < Math.max(10, Math.round(max / 10)))) {return [];}
      return [{
        line: ctx.addedList[0].line,
        text: `${ctx.file}: ${ctx.lines.length} lines (+${ctx.addedList.length}/-${ctx.removed})`,
        why: `${this.why} (limit ${max})`,
      }];
    },
  },
  {
    id: 'large-function', dimension: 'standards', severity: 'yellow', stacks: CODE,
    why: 'A long function or build method is hard to review and test. Split it (extract widgets/helpers).',
    file(ctx) {
      const max = ctx.review.maxFunctionLines;
      const long = ctx.spans.filter(s => s.kind === 'function' && s.end - s.start + 1 > max);
      const out = [];
      for (const s of long) {
        if (long.some(p => p !== s && p.start < s.start && p.end >= s.end)) {continue;}
        const inside = ctx.addedList.filter(a => a.line - 1 >= s.start && a.line - 1 <= s.end);
        const openerAdded = ctx.added.has(s.start + 1);
        const length = s.end - s.start + 1;
        // a new long function, or an existing one this change pushed past the
        // limit with a real amount of new code (not a two-line tweak at 81 lines)
        const crossed = length - inside.length <= max && inside.length >= Math.max(5, Math.round(max / 10));
        if (!inside.length || (!openerAdded && !crossed)) {continue;}
        out.push({
          line: openerAdded ? s.start + 1 : inside[0].line,
          text: signatureLine(ctx, s.start),
          why: `${this.why} (${s.end - s.start + 1} lines, limit ${max}, ${inside.length} added)`,
        });
      }
      return out;
    },
  },
  {
    id: 'hardcoded-ui-string', dimension: 'standards', severity: 'yellow', stacks: ['dart', 'js'],
    why: 'Untranslated string: the app is localised, so a literal shows in one language for every locale. Move it to the translation files.',
    line(text, ctx) {
      if (!ctx.repo.localized || /\.(tr|i18n|plural)\b|\btr\(|\bt\(|AppLocalizations|S\.of|intl|Intl\./.test(text)) {return null;}
      if (/^\s*(import|export|part|\/\/|\*|@)/.test(text) || /\b(print|debugPrint|log|Exception|Error|assert|Key|ValueKey|semanticsIdentifier|testID|route|path|name)\s*[(:]/.test(text)) {return null;}
      const human = s => /[A-Za-z]{3,}/.test(s) && /\s/.test(s.trim()) || /^[A-Z][a-z]{2,}[!?.]?$/.test(s.trim());
      const notKey = s => !/^[\w.-]+$/.test(s) || /^[A-Z][a-z]+[!?.]?$/.test(s);
      const looksUi = s => human(s) && notKey(s) && !/:\/\/|\/|\.(png|svg|json|jpg)$|%|\$\{|^\w+_\w+$/.test(s);
      let m;
      if (ctx.stack === 'dart') {
        m = /\bText\s*\(\s*(['"])((?:(?!\1).)*)\1/.exec(text) ||
          /\b(?:title|label|labelText|hintText|tooltip|message|content|semanticLabel|helperText|errorText|buttonText|subtitle|description)\s*:\s*(?:const\s+)?(['"])((?:(?!\1).)*)\1/.exec(text);
        return m && looksUi(m[2]) ? true : null;
      }
      m = />\s*([A-Za-z][^<>{}]*[A-Za-z][.!?]?)\s*</.exec(text) ||
        /\b(?:title|placeholder|label|accessibilityLabel|alt)\s*=\s*(["'])((?:(?!\1).)*)\1/.exec(text);
      if (!m) {return null;}
      return looksUi(m[2] !== undefined ? m[2] : m[1]) ? true : null;
    },
  },
  {
    id: 'magic-colors', dimension: 'standards', severity: 'yellow', stacks: ['dart'],
    why: 'A raw colour in presentation code bypasses the theme (dark mode, rebrand). Use a theme/colour-scheme token.',
    line(text, ctx, n) {
      if (!ctx.repo.hasTheme || !PRESENTATION_PATH.test(ctx.file) || /theme|colors?\.dart$|palette/i.test(ctx.file)) {return null;}
      return /\bColor\(\s*0x[0-9A-Fa-f]{6,8}\s*\)|\bColors\.(?!transparent\b)\w+/.test(codeAt(ctx, n)) ? true : null;
    },
  },

  // ---------------------------------------------------------------- architecture
  {
    id: 'layer-import', dimension: 'architecture', severity: 'yellow', stacks: ['dart', 'js'],
    why: 'Import crosses a layer boundary.',
    file(ctx) {
      const out = [];
      if (!ctx.layers.length) {return out;}
      for (const a of ctx.addedList) {
        const spec = importSpec(a.text, ctx.stack);
        if (!spec) {continue;}
        const resolved = resolveImport(spec, ctx.file, ctx.repo.packages);
        const hits = layerViolations(ctx.file, spec, resolved, ctx.layers);
        if (!hits.length) {continue;}
        // one lead per import; every rule it breaks is named in the why
        const why = hits.map(v => {
          const pre = ctx.preExisting && ctx.preExisting[v.name];
          return `${v.name}: ${v.why}${pre !== undefined ? ` (${pre} pre-existing in repo)` : ''}`;
        }).join(' | ');
        out.push({ line: a.line, rule: `layer-import:${hits[0].name}`, why });
      }
      return out;
    },
  },
  {
    id: 'service-locator-in-ui', dimension: 'architecture', severity: 'yellow', stacks: ['dart', 'js'],
    why: 'Service locator lookup inside a widget build: the widget hides its dependency and cannot be tested with a fake. Inject via the constructor or a BlocProvider/Provider at the route.',
    file(ctx) {
      if (!PRESENTATION_PATH.test(ctx.file)) {return [];}
      const re = /\bGetIt\.I(?:nstance)?\b|\bgetIt\s*[<(.]|\bsl\s*[<(]|\blocator\s*[<(]|\bGet\.find\s*</;
      return ctx.addedList.filter(a => re.test(codeAt(ctx, a.line)) && inBuild(ctx.spans, a.line - 1)).map(a => ({ line: a.line }));
    },
  },
  {
    id: 'di-bypass', dimension: 'architecture', severity: 'yellow', stacks: CODE,
    why: 'Creates its own HTTP client, bypassing the shared one\'s interceptors (auth, logging, retry, certificate pinning). Inject the app\'s client instead.',
    line(text, ctx, n) {
      if (!/\bDio\s*\(|\bhttp\.Client\s*\(|\baxios\.create\s*\(|\bOkHttpClient(?:\.Builder)?\s*\(|URLSession\s*\(\s*configuration/.test(codeAt(ctx, n))) {return null;}
      const dirs = ctx.review.httpClientDirs || [];
      return dirs.some(d => ctx.file === d || ctx.file.startsWith(`${d.replace(/\/$/, '')}/`) || (hasGlob(d) && globMatch(d, ctx.file))) ? null : true;
    },
  },
];

// The line a multi-line signature starts on: `Future<void> _load(` for a
// body that opens on `}) async {`.
function signatureLine(ctx, start) {
  for (let i = start; i >= Math.max(0, start - 10); i--) {
    const t = ctx.code[i].trim();
    if (/^[\w@<>?,.\s[\]]*\b\w+\s*(<[^>]*>)?\s*\(/.test(t) && !/^[)}\]]/.test(t)) {return ctx.lines[i];}
  }
  return ctx.lines[start];
}

// Added lines matching `use` after an await in the same function, with no
// mounted check between the await and the line.
function afterAwait(ctx, use) {
  const out = [];
  for (const a of ctx.addedList) {
    const li = a.line - 1;
    const code = ctx.code[li];
    if (!use.test(code)) {continue;}
    const fn = innermostFunction(ctx.spans, li);
    if (!fn) {continue;}
    let lastAwait = -1;
    for (let i = fn.start; i < li; i++) {
      const c = i === fn.start ? ctx.code[i].slice(ctx.code[i].lastIndexOf('{') + 1) : ctx.code[i];
      if (!/\bawait\b/.test(c)) {continue;}
      if (i !== fn.start && innermostFunction(ctx.spans, i) !== fn) {continue;}
      lastAwait = i;
    }
    if (lastAwait < 0) {continue;}
    const between = ctx.code.slice(lastAwait, li + 1).join('\n');
    if (/\bmounted\b/.test(between)) {continue;}
    out.push({ line: a.line, why: undefined });
  }
  return out;
}

// --- scanning ----------------------------------------------------------------------

function ruleApplies(rule, stack, isTest) {
  if (isTest && !rule.tests) {return false;}
  return rule.stacks === '*' || rule.stacks.includes(stack);
}

function isDisabled(id, disable) {
  return (disable || []).some(d => d === id || id.startsWith(`${d}:`));
}

function reviewOf(cfg) {
  return { ...REVIEW_DEFAULTS, ...((cfg && cfg.review) || {}) };
}

// One file -> its leads. `entry` = { file, content, added: [{ line, text, hunk }], removed }.
function scanFile(entry, opts = {}) {
  const file = entry.file;
  if (isGenerated(file)) {return [];}
  const stack = stackOf(file);
  const isTest = isTestFile(file);
  const content = entry.content == null ? entry.added.map(a => a.text).join('\n') : entry.content;
  const lines = content.split('\n');
  const code = blankCode(content, stack).split('\n');
  const review = opts.review || REVIEW_DEFAULTS;
  const ctx = {
    file,
    stack,
    isTest,
    content,
    lines,
    code,
    addedList: entry.added,
    added: new Map(entry.added.map(a => [a.line, a.text])),
    removed: entry.removed || 0,
    review,
    repo: opts.repo || { packages: [], localized: false, hasTheme: false },
    layers: opts.layers || [],
    preExisting: opts.preExisting || null,
  };
  let spans = null;
  Object.defineProperty(ctx, 'spans', { get: () => { spans = spans || buildSpans(code); return spans; } });

  const leads = [];
  const seen = new Set();
  const push = (rule, line, extra = {}) => {
    if (!ctx.added.has(line)) {return;}
    const id = extra.rule || rule.id;
    const key = `${id}:${line}`;
    if (seen.has(key)) {return;}
    seen.add(key);
    const raw = extra.text !== undefined ? extra.text : (lineAt(ctx, line) || ctx.added.get(line));
    leads.push({
      dimension: rule.dimension,
      rule: id,
      severity: extra.severity || rule.severity,
      file,
      line,
      text: maskSecrets(String(raw).trim().slice(0, 200), extra.mask),
      why: extra.why || rule.why,
    });
  };

  for (const rule of RULES) {
    if (!ruleApplies(rule, stack, isTest)) {continue;}
    if (isDisabled(rule.id, review.disable)) {continue;}
    if (opts.only && !opts.only.includes(rule.dimension)) {continue;}
    if (rule.line) {
      for (const a of ctx.addedList) {
        const r = rule.line(a.text, ctx, a.line);
        if (r) {push(rule, a.line, r === true ? {} : r);}
      }
    } else {
      for (const r of rule.file(ctx) || []) {
        if (r.rule && isDisabled(r.rule, review.disable)) {continue;}
        push(rule, r.line, r);
      }
    }
  }
  return leads;
}

function summarize(leads) {
  const summary = {};
  for (const d of DIMENSIONS) {summary[d] = 0;}
  for (const l of leads) {summary[l.dimension] += 1;}
  return summary;
}

// Pure entry point for tests: entries + config -> { leads, summary }.
function scanEntries(entries, opts = {}) {
  const leads = [];
  for (const e of entries) {leads.push(...scanFile(e, opts));}
  const order = d => DIMENSIONS.indexOf(d);
  leads.sort((a, b) => order(a.dimension) - order(b.dimension) || a.file.localeCompare(b.file) || a.line - b.line);
  return { leads, summary: summarize(leads) };
}

// Facts about the repo the rules need, from its file list and a reader.
function repoInfoFrom(paths, read, cfg) {
  const packages = [];
  for (const p of paths.filter(x => path.posix.basename(x) === 'pubspec.yaml' && !isGenerated(x))) {
    const m = /^name:\s*['"]?([\w-]+)/m.exec(read(p) || '');
    if (m) {packages.push({ dir: path.posix.dirname(p) === '.' ? '' : path.posix.dirname(p), name: m[1] });}
  }
  const layouts = [];
  for (const [src, stack] of [['lib', 'dart'], ['src', 'js']]) {
    const re = new RegExp(`^${src}/features/[^/]+/(data|domain|presentation)/`);
    const kinds = new Set(paths.map(p => (re.exec(p) || [])[1]).filter(Boolean));
    if (kinds.size >= 2) {layouts.push({ src, stack });}
  }
  const locales = (cfg && cfg.project && cfg.project.locales) || [];
  const localized = locales.length > 1 ||
    paths.some(p => /(^|\/)(l10n|i18n|locales|translations)\//.test(p) || /\.arb$/.test(p));
  const hasTheme = paths.some(p => /(^|\/)themes?\//.test(p) || /(^|\/)app_theme\.dart$/.test(p));
  return { packages, layouts, localized, hasTheme };
}

function layersFor(review, repo) {
  if (Array.isArray(review.layers) && review.layers.length) {return review.layers;}
  return [].concat(...repo.layouts.map(defaultLayers));
}

// --- lint ----------------------------------------------------------------------------

// flutter/dart analyze and `file:line:col: message [rule]` (eslint -f unix,
// many others) -> [{ file, line, col, severity, message, rule }].
function parseLintOutput(text, repoRoot) {
  const issues = [];
  const rel = f => {
    let p = f.trim();
    if (repoRoot && path.isAbsolute(p)) {p = path.relative(repoRoot, p);}
    return p.split(path.sep).join('/').replace(/^\.\//, '');
  };
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/\r$/, '');
    let m = /^\s*(error|warning|info|hint|lint)\s+[•·]\s+(.+?)\s+[•·]\s+(\S+?):(\d+):(\d+)\s+[•·]\s+(\S+)\s*$/.exec(line);
    if (m) {
      issues.push({ file: rel(m[3]), line: +m[4], col: +m[5], severity: m[1], message: m[2], rule: m[6] });
      continue;
    }
    m = /^\s*(error|warning|info|hint|lint)\s+-\s+(\S+?):(\d+):(\d+)\s+-\s+(.+?)\s+-\s+(\S+)\s*$/.exec(line);
    if (m) {
      issues.push({ file: rel(m[2]), line: +m[3], col: +m[4], severity: m[1], message: m[5], rule: m[6] });
      continue;
    }
    m = /^(.+?):(\d+):(\d+):\s*(.*?)\s*(?:\[(?:(\w+)\/)?([^\]]+)\])?\s*$/.exec(line);
    if (m && !/^\s/.test(m[1])) {
      let message = m[4];
      let severity = (m[5] || '').toLowerCase();
      const sev = /^(error|warning|info|hint)\s*:\s*/i.exec(message);
      if (sev) { severity = severity || sev[1].toLowerCase(); message = message.slice(sev[0].length); }
      issues.push({ file: rel(m[1]), line: +m[2], col: +m[3], severity: severity || 'warning', message, rule: m[6] || 'lint' });
    }
  }
  return issues;
}

// Splits issues into leads (changed file, added line) and context counts.
function lintLeads(issues, entries, review) {
  const byFile = new Map(entries.map(e => [e.file, e]));
  const leads = [];
  let preExisting = 0;
  let outside = 0;
  for (const i of issues) {
    const e = byFile.get(i.file);
    if (!e) { outside += 1; continue; }
    const added = e.added.find(a => a.line === i.line);
    if (!added) { preExisting += 1; continue; }
    const rule = `lint:${i.rule}`;
    if (isDisabled(rule, review && review.disable)) {continue;}
    leads.push({
      dimension: 'standards',
      rule,
      severity: i.severity === 'error' ? 'red' : 'yellow',
      file: i.file,
      line: i.line,
      text: maskSecrets(added.text.trim().slice(0, 200)),
      why: `${i.severity}: ${i.message}`,
    });
  }
  return { leads, total: issues.length, onAddedLines: leads.length, preExistingInTouchedFiles: preExisting, outsideChangedFiles: outside };
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function hasCommand(name) {
  try {
    execFileSync('/bin/sh', ['-c', `command -v ${name}`], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

// The lint command to run, with {files} filled in, or null.
function lintCommandFor(review, repoDir, files, force) {
  let cmd = review.lintCommand || '';
  let list = files;
  if (!cmd && force) {
    if (fs.existsSync(path.join(repoDir, 'pubspec.yaml'))) {
      cmd = hasCommand('flutter') ? 'flutter analyze --no-fatal-infos --no-fatal-warnings {files}' : 'dart analyze {files}';
      list = files.filter(f => f.endsWith('.dart'));
    } else if (fs.existsSync(path.join(repoDir, 'package.json'))) {
      let pkg = {};
      try { pkg = JSON.parse(fs.readFileSync(path.join(repoDir, 'package.json'), 'utf8')); } catch (_) { /* no eslint then */ }
      if ({ ...pkg.dependencies, ...pkg.devDependencies }.eslint) {
        cmd = 'npx eslint -f unix {files}';
        list = files.filter(f => /\.[cm]?[jt]sx?$/.test(f));
      }
    }
  }
  if (!cmd) {return null;}
  if (cmd.includes('{files}')) {
    if (!list.length) {return null;}
    cmd = cmd.split('{files}').join(list.map(shellQuote).join(' '));
  }
  return cmd;
}

function runLint(cmd, repoDir) {
  try {
    const out = execFileSync('/bin/sh', ['-c', cmd], {
      cwd: repoDir, encoding: 'utf8', timeout: 5 * 60 * 1000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { exitCode: 0, output: out };
  } catch (err) {
    return { exitCode: typeof err.status === 'number' ? err.status : 1, output: `${err.stdout || ''}\n${err.stderr || ''}`, timedOut: err.signal === 'SIGTERM' };
  }
}

// --- git -----------------------------------------------------------------------------

function git(repo, args, opts = {}) {
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd: repo, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...opts,
  });
}

function revExists(repo, rev) {
  try {
    git(repo, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
    return true;
  } catch (_) {
    return false;
  }
}

// The base ref to diff against: --base, then config, then main/master.
function resolveBase(repo, base, cfg) {
  const remote = (cfg && cfg.repo && cfg.repo.remote) || 'origin';
  const wanted = base || (cfg && cfg.repo && cfg.repo.defaultBranch) || 'main';
  const candidates = [wanted, `${remote}/${wanted}`];
  if (!base) {candidates.push('main', 'master', `${remote}/main`, `${remote}/master`);}
  const found = candidates.find(c => revExists(repo, c));
  if (!found) {throw new Error(`base "${wanted}" is not a branch, tag or commit in ${repo} (pass --base <ref>)`);}
  return found;
}

function showFile(repo, file) {
  try {
    return git(repo, ['show', `HEAD:${file}`]);
  } catch (_) {
    return null;
  }
}

// Repo-wide count of existing imports per layer rule (minus the added ones).
function preExistingLayerCounts(repo, layers, repoInfo, addedKeys) {
  const counts = {};
  for (const l of layers) {counts[l.name] = 0;}
  if (!layers.length) {return counts;}
  let out = '';
  try {
    out = git(repo, ['grep', '-n', '-I', '-E', '^[[:space:]]*(import|export)[[:space:]]|require\\(', 'HEAD', '--', '*.dart', '*.js', '*.jsx', '*.ts', '*.tsx']);
  } catch (_) {
    return counts;
  }
  for (const row of out.split('\n')) {
    const m = /^HEAD:(.+?):(\d+):(.*)$/.exec(row);
    if (!m || isGenerated(m[1]) || isTestFile(m[1]) || addedKeys.has(`${m[1]}:${m[2]}`)) {continue;}
    const stack = stackOf(m[1]);
    const spec = importSpec(m[3], stack);
    if (!spec) {continue;}
    const resolved = resolveImport(spec, m[1], repoInfo.packages);
    for (const v of layerViolations(m[1], spec, resolved, layers)) {counts[v.name] += 1;}
  }
  return counts;
}

// The whole scan against a git repo. Throws on git errors.
function scanRepo({ repo, base, cfg, only, lint }) {
  const review = reviewOf(cfg);
  const baseRef = resolveBase(repo, base, cfg);
  const mergeBase = git(repo, ['merge-base', baseRef, 'HEAD']).trim();
  const head = git(repo, ['rev-parse', 'HEAD']).trim();
  const diff = git(repo, ['diff', '--no-color', '--no-ext-diff', '-U0', '-M', mergeBase, 'HEAD']);
  const parsed = parseUnifiedDiff(diff);
  const skipped = parsed.filter(f => isGenerated(f.file)).map(f => f.file);
  const entries = parsed.filter(f => !isGenerated(f.file) && f.added.length).map(f => {
    const content = showFile(repo, f.file);
    return { ...f, content: content !== null && content.length < 4 * 1024 * 1024 ? content.replace(/\n$/, '') : null };
  });

  const paths = git(repo, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n').filter(Boolean);
  const repoInfo = repoInfoFrom(paths, p => showFile(repo, p), cfg);
  const layers = isDisabled('layer-import', review.disable) || (only && !only.includes('architecture')) ? [] : layersFor(review, repoInfo);
  const addedKeys = new Set();
  for (const e of entries) {for (const a of e.added) {addedKeys.add(`${e.file}:${a.line}`);}}
  const preExisting = preExistingLayerCounts(repo, layers, repoInfo, addedKeys);

  const { leads } = scanEntries(entries, { review, repo: repoInfo, layers, preExisting, only });

  let lintResult = null;
  const wantLint = (lint || review.lintCommand) && (!only || only.includes('standards')) && !isDisabled('lint', review.disable);
  if (wantLint) {
    const cmd = lintCommandFor(review, repo, entries.map(e => e.file), true);
    if (cmd) {
      const run = runLint(cmd, repo);
      const issues = parseLintOutput(run.output, repo);
      const split = lintLeads(issues, entries, review);
      leads.push(...split.leads);
      lintResult = {
        command: cmd, exitCode: run.exitCode, timedOut: Boolean(run.timedOut),
        total: split.total, onAddedLines: split.onAddedLines,
        preExistingInTouchedFiles: split.preExistingInTouchedFiles, outsideChangedFiles: split.outsideChangedFiles,
      };
    } else {
      lintResult = { command: null, note: 'no lint command: set review.lintCommand, or no lintable files changed' };
    }
  }
  const order = d => DIMENSIONS.indexOf(d);
  leads.sort((a, b) => order(a.dimension) - order(b.dimension) || a.file.localeCompare(b.file) || a.line - b.line);

  return {
    base: baseRef,
    mergeBase,
    head,
    filesScanned: entries.length,
    skippedGenerated: skipped,
    leads,
    lint: lintResult,
    layers: layers.map(l => ({ name: l.name, preExisting: preExisting[l.name] || 0, added: leads.filter(x => x.rule.startsWith('layer-import:') && x.why.split(' | ').some(w => w.startsWith(`${l.name}:`))).length })),
    summary: summarize(leads),
  };
}

// --- output ----------------------------------------------------------------------------

function formatHuman(result, only) {
  const out = [];
  const total = result.leads.length;
  out.push(`review-scan: ${result.base} (merge-base ${result.mergeBase.slice(0, 8)}) .. HEAD ${result.head.slice(0, 8)}`);
  out.push(`${result.filesScanned} file(s) scanned, ${total} lead(s)${result.skippedGenerated.length ? `, ${result.skippedGenerated.length} generated file(s) skipped` : ''}`);
  for (const d of DIMENSIONS) {
    if (only && !only.includes(d)) {continue;}
    const rows = result.leads.filter(l => l.dimension === d);
    out.push('');
    out.push(`== ${d} (${rows.length}) ==`);
    if (d === 'architecture' && result.layers.length) {
      out.push(`  layer rules: ${result.layers.map(l => `${l.name} ${l.added} added / ${l.preExisting} pre-existing`).join('; ')}`);
    }
    if (d === 'standards' && result.lint) {
      out.push(result.lint.command
        ? `  lint: ${result.lint.onAddedLines} on added lines, ${result.lint.preExistingInTouchedFiles} pre-existing in touched files (${result.lint.command.slice(0, 80)}, exit ${result.lint.exitCode})`
        : `  lint: ${result.lint.note}`);
    }
    if (!rows.length) { out.push('  none'); continue; }
    for (const l of rows) {
      out.push(`${l.file}:${l.line}  [${l.rule}] ${l.text}`);
      out.push(`    ${l.severity}: ${l.why}`);
    }
  }
  out.push('');
  out.push(CLOSING);
  return out.join('\n');
}

function formatMarkdown(result) {
  const out = [];
  out.push('# Static scan leads');
  out.push('');
  out.push(`Base \`${result.base}\` (merge-base \`${result.mergeBase.slice(0, 8)}\`), head \`${result.head.slice(0, 8)}\`. ${result.filesScanned} file(s) scanned, ${result.leads.length} lead(s).`);
  out.push('');
  out.push(`> ${CLOSING}`);
  out.push('');
  out.push('| Dimension | Leads |');
  out.push('|-----------|------:|');
  for (const d of DIMENSIONS) {out.push(`| ${d} | ${result.summary[d]} |`);}
  for (const d of DIMENSIONS) {
    const rows = result.leads.filter(l => l.dimension === d);
    if (!rows.length) {continue;}
    out.push('');
    out.push(`## ${d}`);
    out.push('');
    for (const l of rows) {
      out.push(`- \`${l.file}:${l.line}\` **${l.rule}** (${l.severity}): \`${l.text.replace(/`/g, "'")}\``);
      out.push(`  ${l.why}`);
    }
  }
  if (result.layers.length) {
    out.push('');
    out.push('Layer rules (pre-existing imports are context, not leads): ' +
      result.layers.map(l => `${l.name} ${l.preExisting}`).join(', '));
  }
  return `${out.join('\n')}\n`;
}

module.exports = {
  DIMENSIONS,
  RULES,
  parseArgs,
  parseUnifiedDiff,
  blankCode,
  buildSpans,
  classifyHeader,
  enclosing,
  globToRegex,
  globMatch,
  importSpec,
  resolveImport,
  defaultLayers,
  layerViolations,
  secretCandidates,
  maskSecrets,
  isGenerated,
  isTestFile,
  stackOf,
  scanFile,
  scanEntries,
  repoInfoFrom,
  layersFor,
  parseLintOutput,
  lintLeads,
  lintCommandFor,
  runLint,
  resolveBase,
  scanRepo,
  formatHuman,
  formatMarkdown,
};

// --- CLI ----------------------------------------------------------------------------

const HELP = `review-scan.js - static leads for the code-review phase

Usage
  node qc/review-scan.js [--base <ref>] [--repo <dir>] [--json] [--save]
                         [--only owasp,perf,memory,concurrency,standards,architecture]
                         [--lint]

Scans the diff of HEAD against its merge-base with --base (default:
repo.defaultBranch, then main/master) and prints leads per dimension. Only
added lines are leads. Leads are not findings: open each one in the code
and confirm it before recording it.

  --base <ref>   branch, tag or commit to diff against
  --repo <dir>   repository to scan (default: the current directory)
  --json         machine-readable output
  --save         also write <run>/review/scan.json and scan.md (needs a run)
  --only <dims>  comma-separated dimensions to report
  --lint         run the linter (review.lintCommand, else flutter/dart analyze
                 or eslint, detected) and keep issues on added lines

Config (qc.config.json "review"): lintCommand, layers, disable, maxFileLines,
maxFunctionLines, httpClientDirs.

Exit: 0 when the scan ran (leads are not failures), 1 on a usage or git error.
`;

function loadCfg(repo) {
  // eslint-disable-next-line global-require
  const config = require('./config.js');
  let cfg = config.loadConfigOptional();
  if (!cfg.configPath && repo && path.resolve(repo) !== process.cwd()) {
    process.chdir(repo);
    cfg = config.loadConfigOptional();
  }
  return cfg;
}

function saveRun(result) {
  // QC_RUN_DIR (set by `qc-check run`) needs no config; otherwise the active run.
  let runDir = process.env.QC_RUN_DIR && fs.existsSync(process.env.QC_RUN_DIR) ? process.env.QC_RUN_DIR : null;
  if (!runDir) {
    try {
      const cfg = require('./config.js').loadConfigOptional(); // eslint-disable-line global-require
      const run = cfg.configPath ? require('./runs.js').currentRun() : null; // eslint-disable-line global-require
      runDir = run ? run.dir : null;
    } catch (_) {
      runDir = null;
    }
  }
  if (!runDir) {return null;}
  const dir = path.join(runDir, 'review');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'scan.json'), `${JSON.stringify(result, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'scan.md'), formatMarkdown(result));
  return dir;
}

if (require.main === module) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`ERROR: ${err.message}\n${HELP}`);
    process.exit(1);
  }
  if (args.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  try {
    const repo = path.resolve(args.repo || process.cwd());
    const cfg = loadCfg(repo);
    const top = git(repo, ['rev-parse', '--show-toplevel']).trim();
    const result = scanRepo({ repo: top, base: args.base, cfg, only: args.only, lint: args.lint });
    if (args.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatHuman(result, args.only)}\n`);
    }
    if (args.save) {
      const dir = saveRun(result);
      process.stderr.write(dir ? `saved: ${path.join(dir, 'scan.json')} and scan.md\n` : 'not saved: no QC run in progress (start one, or set QC_RUN_DIR)\n');
    }
    process.exit(0);
  } catch (err) {
    const msg = String((err.stderr && err.stderr.toString().trim()) || err.message || err).split('\n')[0];
    process.stderr.write(`ERROR: ${msg}\n`);
    process.exit(1);
  }
}
