#!/usr/bin/env node
// Fails if sw.js precaches a file that does not exist (a missing file would make
// the whole service worker install fail, and the app would not work offline).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sw = fs.readFileSync(path.join(rootDir, 'sw.js'), 'utf8');
const list = [...sw.matchAll(/'\.\/([^']+)'/g)].map(m => m[1]).filter(p => p !== '');
let ok = true;
for (const rel of list) {
  const file = path.join(rootDir, rel);
  if (!fs.existsSync(file)) { console.error(`sw.js precaches missing file: ${rel}`); ok = false; }
}
if (!ok) process.exit(1);
console.log(`sw.js precache OK (${list.length} files)`);
