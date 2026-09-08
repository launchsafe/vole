#!/usr/bin/env node
/**
 * The NON-GOALS charter and its CI canary (tier 3 #24, #8).
 *
 * Write down what Vole will never build and make each line executable rather
 * than a memo. This script is the canary: it enumerates every network-capable
 * call site in the shipped source and fails unless each one is either routed
 * through the egress() choke point or on the declared inventory — proving
 * "nothing phones home by default" about THIS source tree, on every CI run.
 *
 * Source text is normalized before pattern-matching (comments and string
 * literals are blanked): Vole's own detection code legitimately CONTAINS the
 * strings 'curl', 'mitmproxy' and 'fetch(' as the patterns it hunts for in
 * agent transcripts, and the canary must not confuse auditing a call with
 * making one.
 *
 * A CI check proves a property of the shipped source, not of a modified
 * build — anyone can fork Vole and delete the test, so the charter is evidence
 * about the release the user installed and says so.
 *
 * Run: node scripts/check-egress.mjs   (paths resolve from this file's location).
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const core = join(here, '..');
const repo = join(core, '..', '..');
const SELF = fileURLToPath(import.meta.url);

/** The shipped NON-GOALS charter. Each line is enforced by a check below. */
const NON_GOALS = [
  { line: 'No proxy, MITM or base-URL rewrite — Vole never sits in the path.', check: 'no-traffic-interposition' },
  { line: 'No browser extension — Vole never runs inside the browser it audits.', check: 'no-browser-extension' },
  { line: 'No prompt, tool-argument or tool-output storage — metadata, hashes and counts only.', check: 'no-content-columns' },
  { line: 'Nothing leaves the machine by default — every outbound call routes through egress() or is on the declared inventory.', check: 'single-choke-point' },
];

/**
 * The declared egress inventory (mirrors egress.ts egressInventory()). A
 * declared site still has to honour the kill switch — the guard token is
 * checked in the file, not assumed.
 */
const DECLARED_SITES = [
  // The update check + update download: disclosed, reader-side (apps/mac).
  // The VOLE_NO_EGRESS guard is wired into UpdateChecker.swift's egress()
  // choke point — the Swift twin of src/egress.ts.
  { file: /apps\/mac\/.*UpdateChecker\.swift$/, guard: 'VOLE_NO_EGRESS', why: 'version check and update download on launch (disclosed)' },
];

// Code-shaped network APIs only: an API CALL, not a string that names one.
// (importing node:http is not a call; execFileSync('curl') is.)
const NET_API = [
  /\bfetch\s*\(/,
  /\bhttps?\.request\b/,
  /\bXMLHttpRequest\b/,
  /new\s+WebSocket\b/,
  /\bnet\.connect\b/,
  /\.connect\(\s*['"`]\d/,
  /exec(?:File)?Sync\(\s*['"`](?:curl|wget)/,
  /spawn(?:Sync)?\(\s*['"`](?:curl|wget)/,
  /\bURLSession\b/,
  /\bdataTask\b/,
  /\bdownloadTask\b/,
  /\bCFNetwork\b/,
  /\bNSURLConnection\b/,
];

/** Blanks comments and string literals so pattern DATA never reads as a call. */
function codeOnly(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/g, '$1$1');
}

/** Strips comments but KEEPS string literals — the guard check's normal form:
 *  a kill-switch env var can only appear as a string literal in Swift, so
 *  blanking literals (codeOnly) would erase the very token being checked for.
 *  Comments still do not count: a commented-out guard guards nothing. */
function noComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function listFiles(root, exts, out = []) {
  if (!existsSync(root)) return out;
  for (const e of readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue;
    if (exts.some((x) => e.name.endsWith(x))) out.push(e.parentPath ? join(e.parentPath, e.name) : e.path);
  }
  return out;
}

const results = [];

function check(name, fn) {
  const failures = [];
  try {
    fn(failures);
  } catch (err) {
    failures.push(`check crashed: ${err instanceof Error ? err.message : String(err)}`);
  }
  results.push({ name, failures });
}

function scanRoots() {
  return [
    ...listFiles(join(core, 'src'), ['.ts']),
    ...listFiles(join(core, 'scripts'), ['.ts', '.mjs']),
    ...listFiles(join(repo, 'apps', 'mac', 'Sources'), ['.swift']),
  ].filter((f) => !f.includes('node_modules') && !f.endsWith('.test.ts') && f !== SELF);
}

// ── single-choke-point ──────────────────────────────────────────────────────
check('single-choke-point', (failures) => {
  for (const f of scanRoots()) {
    let code;
    try {
      code = codeOnly(readFileSync(f, 'utf8'));
    } catch {
      continue;
    }
    const hits = NET_API.filter((re) => re.test(code));
    if (hits.length === 0) continue;
    const rel = relative(repo, f);
    const declared = DECLARED_SITES.find((d) => d.file.test(rel));
    if (declared) {
      // Declared: the kill-switch guard must be present in the file's code —
      // strings intact (env var names are string literals), comments stripped.
      if (declared.guard && !noComments(readFileSync(f, 'utf8')).includes(declared.guard)) {
        failures.push(
          `${rel}: declared egress site (${declared.why}) but the ${declared.guard} guard is absent — the call is un-guarded`,
        );
      }
      continue;
    }
    if (rel.endsWith('src/egress.ts')) continue; // the choke point itself
    if (/egress\s*\(/.test(code)) continue; // routes through the choke point
    failures.push(`${rel}: network-capable API (${hits.map(String).join(', ')}) with no egress() route and not on the declared inventory`);
  }
});

// ── no-traffic-interposition ────────────────────────────────────────────────
check('no-traffic-interposition', (failures) => {
  const BAD = /mitmproxy|http-proxy|httpProxy|ProxyPass|ssl-unwrap|intercept\w*socket/i;
  for (const f of scanRoots()) {
    if (BAD.test(codeOnly(readFileSync(f, 'utf8')))) {
      failures.push(`${relative(repo, f)}: traffic-interposition code (proxy/MITM) — a NON-GOAL`);
    }
  }
});

// ── no-browser-extension ────────────────────────────────────────────────────
check('no-browser-extension', (failures) => {
  const BAD = /chrome\.runtime|browser\.runtime\.onMessage|manifest_version\s*[:=]\s*[23]/;
  for (const f of scanRoots()) {
    if (BAD.test(codeOnly(readFileSync(f, 'utf8')))) {
      failures.push(`${relative(repo, f)}: browser-extension code — a NON-GOAL`);
    }
  }
});

// ── no-content-columns ─────────────────────────────────────────────────────
// ALLOWED_COLUMNS (cli/verify.ts) is the deliberate review point of the content
// boundary: no column in it may be content-shaped.
check('no-content-columns', (failures) => {
  const verifyPath = join(core, 'src', 'cli', 'verify.ts');
  if (!existsSync(verifyPath)) {
    failures.push('cli/verify.ts not found — cannot verify the content boundary');
    return;
  }
  const text = readFileSync(verifyPath, 'utf8');
  const badCols = ['prompt', 'message', 'command_text', 'tool_args', 'tool_output', 'body', 'content_text']
    .filter((c) => new RegExp(`['"]${c}['"]\\s*:`).test(text));
  if (badCols.length) failures.push(`ALLOWED_COLUMNS contains content-shaped columns: ${badCols.join(', ')}`);
});

// ── report ─────────────────────────────────────────────────────────────────
console.log('Vole NON-GOALS charter — CI canary');
console.log(`run: ${new Date().toISOString()}\n`);
let failed = 0;
for (const goal of NON_GOALS) {
  const r = results.find((x) => x.name === goal.check);
  const pass = r && r.failures.length === 0;
  if (!pass) failed++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${goal.line}`);
  for (const f of r?.failures ?? ['check missing']) console.log(`        -> ${f}`);
}
console.log(
  `\nThis canary proves a property of the shipped source at the commit CI built, not of a\n` +
    `modified build. It enumerates the network-capable call sites the patterns cover; a\n` +
    `route outside them is invisible to it (see NET_API in scripts/check-egress.mjs).`,
);
process.exit(failed > 0 ? 1 : 0);
