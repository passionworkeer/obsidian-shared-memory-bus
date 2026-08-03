#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targetRoot = path.resolve(process.argv[2] || '');
if (!process.argv[2]) {
  console.error('Usage: node scripts/validate-installed-runtime.mjs <target-root>');
  process.exit(2);
}
const graph = JSON.parse(fs.readFileSync(path.join(repoRoot, 'scripts/install-files.json'), 'utf8'));
const missing = [];
for (const entry of graph.entries) {
  const installed = path.join(targetRoot, entry.destination);
  if (!fs.statSync(installed, { throwIfNoEntry: false })?.isFile()) missing.push(entry.destination);
}
for (const generated of ['install-manifest.json', 'activate-ai-memory.sh', 'activate-ai-memory.ps1']) {
  if (!fs.statSync(path.join(targetRoot, generated), { throwIfNoEntry: false })?.isFile()) missing.push(generated);
}
if (missing.length) throw new Error(`Installed runtime is missing ${missing.length} file(s):\n- ${missing.join('\n- ')}`);

const importPattern = /(?:from\s+|import\s*\(|require\s*\(|new\s+URL\s*\()\s*["'](\.{1,2}\/[^"']+)["']/g;
const importFailures = [];
for (const entry of graph.entries) {
  if (!/\.(?:js|mjs|cjs)$/.test(entry.destination)) continue;
  const installed = path.join(targetRoot, entry.destination);
  const source = fs.readFileSync(installed, 'utf8');
  for (const match of source.matchAll(importPattern)) {
    const raw = path.resolve(path.dirname(installed), match[1]);
    const candidates = path.extname(raw)
      ? [raw]
      : [raw, `${raw}.js`, `${raw}.mjs`, `${raw}.cjs`, `${raw}.json`, path.join(raw, 'index.js'), path.join(raw, 'index.mjs')];
    if (!candidates.some((candidate) => fs.statSync(candidate, { throwIfNoEntry: false })?.isFile())) {
      importFailures.push(`${entry.destination} -> ${match[1]}`);
    }
  }
}
if (importFailures.length) throw new Error(`Installed relative imports are incomplete:\n- ${importFailures.join('\n- ')}`);

const manifest = JSON.parse(fs.readFileSync(path.join(targetRoot, 'install-manifest.json'), 'utf8'));
const expectedManaged = new Set(graph.entries.map((entry) => entry.destination.replaceAll('/', path.sep)));
const actualManaged = new Set((manifest.managedFiles || []).map((value) => String(value)));
for (const destination of expectedManaged) {
  if (!actualManaged.has(destination)) throw new Error(`Install manifest does not manage ${destination}`);
}
console.log(`Installed runtime validated: ${graph.entries.length} source files, ${actualManaged.size} managed paths.`);
