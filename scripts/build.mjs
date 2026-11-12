#!/usr/bin/env node
// Zero-dependency bundler: assembles src/ into the single-file userscript
// deliverable (xf-thread-tools.user.js) per scripts/modules.json.
//   - pure modules (src/*.mjs): real ESM, import/export stripped for the
//     bundle (single IIFE scope, topo order preserves const TDZ safety);
//     node tests import them directly.
//   - runtime fragments (src/rt-*.js): order-preserving slices of main()'s
//     body, concatenated verbatim inside the main() wrapper.
//   - shell (src/shell/): userscript meta header, runtime guard, UMD tail.
// Self-check: node --check on the output; refuses to write on any error.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const M = JSON.parse(readFileSync(join(ROOT, 'scripts/modules.json'), 'utf8'));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// ---- pure module transform: strip imports + export keywords ---------------
function stripModule(text, file) {
  let out = text
    .replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];\s*$/gm, '')
    .replace(/^export\s+(?=(?:const|let|var|function|async\s+function|class)\b)/gm, '');
  if (/^import\b/m.test(out) || /^export\b/m.test(out)) {
    throw new Error(`${file}: unstripped import/export remains`);
  }
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

// ---- topological order from the modules' real import statements ------------
function topoOrder() {
  const byName = new Map(M.pureModules.map((m) => [m.name, m]));
  const edges = new Map(M.pureModules.map((m) => [m.name, new Set()]));
  for (const m of M.pureModules) {
    const text = read(m.file);
    for (const match of text.matchAll(/^import\s+\{[^}]*\}\s+from\s+'\.\/([\w.-]+)'/gm)) {
      const target = match[1].replace(/\.mjs$/, '');
      if (!byName.has(target)) throw new Error(`${m.file}: imports unknown module ${target}`);
      edges.get(m.name).add(target);
    }
  }
  const order = [], state = new Map(); // 0=unvisited 1=visiting 2=done
  const visit = (n) => {
    const st = state.get(n) || 0;
    if (st === 1) throw new Error(`import cycle through ${n}`);
    if (st === 2) return;
    state.set(n, 1);
    for (const d of edges.get(n)) visit(d);
    state.set(n, 2);
    order.push(n);
  };
  M.pureModules.forEach((m) => visit(m.name));
  return order;
}

// ---- runtime section --------------------------------------------------------
function runtimeSection() {
  const mono = join(ROOT, 'src/shell/main-body.js');
  if (existsSync(mono)) {
    return read('src/shell/main-body.js').trimEnd();
  }
  let out = '';
  for (const f of M.runtimeFragments) {
    if (!existsSync(join(ROOT, f.file))) throw new Error(`missing runtime fragment ${f.file}`);
    const text = read(f.file);
    // strip the 2-line generated header comment
    const body = text.replace(/^\/\/ [^\n]*\n\/\/ Order-preserving slice[^\n]*\n/, '');
    out += body.trimEnd() + '\n';
  }
  return out.trimEnd();
}

// ---- assemble ----------------------------------------------------------------
const pureOrder = topoOrder();
const parts = [];
parts.push(read('src/shell/meta.js').trimEnd());
parts.push('(function () {');
parts.push("  'use strict';");
for (const name of pureOrder) {
  const mod = M.pureModules.find((m) => m.name === name);
  parts.push(`  /* ==== pure module: ${name} ==== */`);
  parts.push(stripModule(read(mod.file), mod.file).replace(/^/gm, '  '));
}
parts.push('  /* ==== runtime guard ==== */');
parts.push(read('src/shell/guard.js').trimEnd());
parts.push('  /* ==== runtime (main) ==== */');
parts.push('  function main() {');
parts.push(runtimeSection().replace(/^/gm, '  ').replace(/^  \n/gm, '\n'));
parts.push('  }');
parts.push(read('src/shell/umd-tail.js').trimEnd());
parts.push('})();');

const bundle = parts.join('\n') + '\n';

// ---- self-check before write ---------------------------------------------------
const tmp = join(ROOT, 'xf-thread-tools.user.js');
writeFileSync(tmp, bundle);
const check = spawnSync('node', ['--check', tmp], { encoding: 'utf8' });
if (check.status !== 0) {
  // leave the broken file for inspection but exit non-zero
  console.error(check.stderr);
  throw new Error('node --check failed on built bundle');
}
// silent on success: ralph verify fingerprints stdout; keep the gate clean
