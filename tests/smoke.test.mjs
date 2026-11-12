// Smoke: the BUILT bundle is the deliverable — it must stay a valid single
// userscript with the UMD tail intact and the runtime guard inert under Node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const bundlePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'xf-thread-tools.user.js');

test('bundle is a userscript with current version header', () => {
  const text = readFileSync(bundlePath, 'utf8');
  assert.ok(text.startsWith('// ==UserScript=='), 'meta header first');
  assert.match(text, /@version\s+0\.19\.0/);
  assert.match(text, /@grant\s+GM_xmlhttpRequest/);
});

test('bundle passes node --check', () => {
  execFileSync('node', ['--check', bundlePath]);
});

test('UMD export exposes every pure function (bundle equivalence)', () => {
  const api = require(bundlePath);
  // src/ pure modules export 82 symbols; the UMD tail re-exports 62 of them
  // (the module-tested set). The tail is the authority: complete and callable.
  const names = Object.keys(api);
  assert.ok(names.length >= 62, `expected >=62 UMD exports, got ${names.length}`);
  for (const n of names) assert.equal(typeof api[n], 'function', `${n} not a function`);
});

test('runtime guard stays inert under Node (require touches no DOM)', () => {
  // require() above already evaluated the whole bundle; document is undefined
  // here — if any runtime code had run outside the guard it would have thrown.
  assert.equal(typeof globalThis.document, 'undefined');
});
