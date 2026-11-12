#!/usr/bin/env node
// One-time splitter: slices the original single-file userscript into
// src/ modules per scripts/modules.json. Phases:
//   --phase shell   meta / guard / umd tail (+ monolith main body for phase 1)
//   --phase pure    pure ESM modules (export prefixes + generated imports)
//   --phase runtime runtime fragments (plain byte slices, order-preserving)
//   --phase all
// Source of truth: the committed 0.18.4 single file (git HEAD), so the
// script stays re-runnable even after the bundle becomes build output.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'scripts/modules.json'), 'utf8'));
const PHASE = process.argv.includes('--phase') ? process.argv[process.argv.indexOf('--phase') + 1] : 'all';

// ---- source lines (committed pre-split file) ------------------------------
const SRC_FILE = 'xf-thread-tools.user.js';
const ORIGINAL = execFileSync('git', ['-C', ROOT, 'show', `HEAD:${SRC_FILE}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const L = ORIGINAL.split('\n'); // 1-based access via L[n-1]
const at = (n) => L[n - 1];

// ---- verified layout of the 0.18.4 file (asserted below) ------------------
const PURE1 = { first: 32, last: 698 };   // IIFE-level constants + pure fns
const PURE2 = { first: 5192, last: 5686 }; // late pure block (layout/AI)
const GUARD = { first: 700, last: 711 };
const MAIN_OPEN = 716;                    // 'function main() {'
const MAIN_BODY = { first: 717, last: 5181 };
const MAIN_CLOSE = 5182;
const UMD = { first: 5688, last: 5689 };
const META = { first: 1, last: 16 };

function assertLayout() {
  const ok = (cond, msg) => { if (!cond) throw new Error('layout assert failed: ' + msg); };
  ok(at(MAIN_OPEN).includes('function main()'), 'main open');
  ok(at(MAIN_CLOSE).trim() === '}', 'main close');
  ok(at(GUARD.first).includes('===='), 'guard banner');
  ok(at(GUARD.last).trim() === '}', 'guard close');
  ok(at(UMD.last).includes('module.exports'), 'umd tail');
  ok(at(META.last).trim() === '// ==/UserScript==', 'meta end');
  ok(at(PURE2.first).includes('function layoutMetrics'), 'pure2 start');
}

// ---- top-level declaration scanner ----------------------------------------
const DECL_RE = (indent) => new RegExp('^' + ' '.repeat(indent) + '(?:const|let|var|function|async function|class)\\s+([A-Za-z_$][\\w$]*)');
function topLevelDecls(first, last, indent = 2) {
  const re = DECL_RE(indent);
  const out = [];
  for (let n = first; n <= last; n++) {
    const m = at(n).match(re);
    if (m) out.push({ name: m[1], line: n });
  }
  return out;
}

// Span: declaration line up to the next decl's comment-inclusive start - 1.
// Comment attach: walk up over contiguous // or /* * */ lines, no blank line.
function commentStart(n) {
  let s = n;
  while (s - 1 >= 1) {
    const prev = at(s - 1).trim();
    if (prev === '' || prev.startsWith('/* =====')) break;
    if (prev.startsWith('//') || prev.startsWith('*') || prev.startsWith('/*')) s -= 1; else break;
  }
  return s;
}
function spansOf(decls) {
  return decls.map((d, i) => {
    const start = commentStart(d.line);
    const nextStart = i + 1 < decls.length ? commentStart(decls[i + 1].line) : null;
    return { ...d, start, end: nextStart ? nextStart - 1 : null };
  });
}
function sliceLines(first, last) { return L.slice(first - 1, last).join('\n'); }

// ---- phase: shell ----------------------------------------------------------
function phaseShell() {
  mkdirSync(join(ROOT, 'src/shell'), { recursive: true });
  const meta = sliceLines(META.first, META.last).replace('@version      0.18.4', '@version      0.19.0');
  writeFileSync(join(ROOT, 'src/shell/meta.js'), meta + '\n');
  writeFileSync(join(ROOT, 'src/shell/guard.js'),
    '// Runtime guard: silent exit on non-XF / non-thread pages; under Node\n' +
    '// (tests) document is undefined and nothing below ever runs.\n' +
    sliceLines(GUARD.first + 4, GUARD.last) + '\n');
  writeFileSync(join(ROOT, 'src/shell/umd-tail.js'),
    '// UMD export of the pure functions for node:test (no DOM / GM usage in them).\n' +
    at(UMD.last) + '\n');
  // phase-1 monolith: main() body verbatim, replaced by fragments in --phase runtime
  writeFileSync(join(ROOT, 'src/shell/main-body.js'), sliceLines(MAIN_BODY.first, MAIN_BODY.last) + '\n');
  console.log('shell: meta/guard/umd-tail/main-body written');
}

// ---- phase: pure ------------------------------------------------------------
function phasePure() {
  const decls = [...spansOf(topLevelDecls(PURE1.first, PURE1.last)), ...spansOf(topLevelDecls(PURE2.first, PURE2.last))];
  // late-block last span ends at PURE2.last
  const byName = new Map(decls.map((d) => [d.name, d]));
  const assigned = new Map(); // symbol -> module name
  for (const mod of MANIFEST.pureModules) for (const s of mod.symbols) {
    if (assigned.has(s)) throw new Error(`symbol ${s} assigned twice`);
    if (!byName.has(s)) throw new Error(`manifest symbol not found at IIFE level: ${s}`);
    assigned.set(s, mod.name);
  }
  for (const d of decls) if (!assigned.has(d.name)) throw new Error(`unassigned top-level symbol: ${d.name} (line ${d.line})`);

  // module text = its symbols' spans in ORIGINAL file order
  const texts = new Map();
  for (const mod of MANIFEST.pureModules) {
    const parts = mod.symbols.map((s) => {
      const sp = byName.get(s);
      const end = sp.end != null ? sp.end : (sp.line >= PURE2.first ? PURE2.last : PURE1.last);
      return sliceLines(sp.start, end);
    });
    texts.set(mod.name, parts.join('\n'));
  }

  // cross-module imports: word-boundary refs to other modules' top-level names
  const owners = new Map(); // symbol -> file
  for (const mod of MANIFEST.pureModules) for (const s of mod.symbols) owners.set(s, mod.file);
  for (const mod of MANIFEST.pureModules) {
    const body = texts.get(mod.name);
    const needs = new Map(); // file -> Set<symbol>
    for (const [sym, file] of owners) {
      if (file === mod.file) continue;
      const re = new RegExp(`(?<![.\\w$])${sym}\\b`);
      if (re.test(body)) {
        if (!needs.has(file)) needs.set(file, new Set());
        needs.get(file).add(sym);
      }
    }
    const imports = [...needs.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([file, syms]) => `import { ${[...syms].sort().join(', ')} } from './${file.split('/').pop()}';`)
      .join('\n');
    // export prefix on top-level declarations
    const exported = body.replace(/^  (const|let|var|function|async function|class)\s/gm, (_, kw) => `  export ${kw} `);
    // de-indent 2 -> 0 for ESM (bundle build re-indents via wrapper? no: keep 2-space, valid ESM either way)
    const header = `// ${mod.name}: ${mod.desc} (split from the single-file userscript; see scripts/modules.json)\n`;
    mkdirSync(join(ROOT, dirname(mod.file)), { recursive: true });
    writeFileSync(join(ROOT, mod.file), header + (imports ? imports + '\n\n' : '') + exported.replace(/^  /gm, '') + '\n');
    const depList = needs.size ? [...needs.keys()].map((f) => f.split('/').pop()).join(', ') : '(none)';
    console.log(`pure: ${mod.name} (${mod.symbols.length} symbols; imports: ${depList})`);
  }
}

// ---- phase: runtime ----------------------------------------------------------
function phaseRuntime() {
  const anchors = MANIFEST.runtimeFragments.map((f) => f.anchor);
  const decls = topLevelDecls(MAIN_BODY.first, MAIN_BODY.last, 4);
  const starts = new Map(); // anchor -> start line
  for (const a of anchors) {
    const d = decls.find((x) => x.name === a);
    if (!d) throw new Error(`runtime anchor not found in main() body: ${a}`);
    starts.set(a, commentStart(d.line));
  }
  const ordered = [...starts.entries()].sort((a, b) => a[1] - b[1]);
  for (let i = 0; i < ordered.length; i++) {
    if (i > 0 && ordered[i][1] <= ordered[i - 1][1]) throw new Error(`anchor ${ordered[i][0]} overlaps previous fragment`);
  }
  const fragEnd = (i) => (i + 1 < ordered.length ? ordered[i + 1][1] - 1 : MAIN_BODY.last);
  let concat = [];
  for (let i = 0; i < ordered.length; i++) {
    const [anchor, start] = ordered[i];
    const frag = MANIFEST.runtimeFragments.find((f) => f.anchor === anchor);
    const end = fragEnd(i);
    const text = sliceLines(start, end);
    concat.push(text);
    const header = `// ${frag.name}: ${frag.desc}\n// Order-preserving slice of main()'s body — shares main() scope; no imports.\n`;
    writeFileSync(join(ROOT, frag.file), header + text + '\n');
    console.log(`runtime: ${frag.name} (lines ${start}-${end})`);
  }
  // equivalence check: fragments concatenated == original main() body
  const originalBody = sliceLines(MAIN_BODY.first, MAIN_BODY.last);
  const joined = concat.join('\n');
  if (joined !== originalBody) {
    // find first divergence
    let i = 0; while (i < joined.length && i < originalBody.length && joined[i] === originalBody[i]) i++;
    throw new Error(`fragment concatenation diverges from original main() body at offset ${i}: ${JSON.stringify(joined.slice(i, i + 80))} vs ${JSON.stringify(originalBody.slice(i, i + 80))}`);
  }
  rmSync(join(ROOT, 'src/shell/main-body.js'));
  console.log('runtime: concatenation === original main() body (byte-exact)');
}

assertLayout();
if (PHASE === 'shell' || PHASE === 'all') phaseShell();
if (PHASE === 'pure' || PHASE === 'all') phasePure();
if (PHASE === 'runtime' || PHASE === 'all') phaseRuntime();
console.log(`split complete (phase=${PHASE})`);
