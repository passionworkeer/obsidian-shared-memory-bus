#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = path.join(repoRoot, 'scripts', 'install-files.json');
const checkOnly = process.argv.includes('--check');

const ROOTS = [
  { source: 'bus', extensions: ['.js', '.mjs', '.cjs', '.ps1'] },
  {
    source: 'ops',
    extensions: ['.js', '.mjs', '.cjs', '.ps1', '.py', '.json'],
    exclude: [/^bench\//, /^extract\//, /^migrations\/README\.md$/],
  },
  {
    source: 'retrieval',
    extensions: ['.py', '.js', '.json', '.txt'],
    exclude: [/\.test\.js$/, /^eval\//, /^benchmark/, /^eval-routing\.py$/],
  },
  { source: 'shared', extensions: ['.json'] },
  { source: 'cli', extensions: ['.js', '.json'] },
  { source: 'shared-mcp', extensions: ['.js', '.mjs', '.cjs', '.ps1', '.sh', '.py', '.json'] },
];

const LEGACY_SOURCE_PATHS = new Set();

const FLAT_POWERSHELL_DIRS = [
  'bus',
  'ops/cleanup',
  'ops/run',
  'ops/setup',
  'ops/sync',
  'ops/verify',
];

function posix(value) {
  return value.split(path.sep).join('/');
}

function walkFiles(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === 'node_modules' || entry.name === '__pycache__' || entry.name.startsWith('.pytest_cache')) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...walkFiles(full));
    else if (entry.isFile()) result.push(full);
  }
  return result;
}

function isSafeRelative(value) {
  if (!value || /[\0-\x1f\x7f]/.test(value) || path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value) || /^(?:\\\\|\/\/)/.test(value) || value.includes(':')) return false;
  const segments = value.replace(/\\/g, '/').split('/');
  return segments.every((segment) => segment && segment !== '.' && segment !== '..' && !/[*?\[\]]/.test(segment) && !/[ .]$/.test(segment) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment));
}

function addEntry(entries, source, destination, kind = 'runtime') {
  source = posix(source);
  destination = posix(destination);
  if (LEGACY_SOURCE_PATHS.has(source)) return;
  if (!isSafeRelative(source) || !isSafeRelative(destination)) {
    throw new Error(`Unsafe install graph entry: ${source} -> ${destination}`);
  }
  const sourcePath = path.join(repoRoot, source);
  if (!fs.statSync(sourcePath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Install graph source is missing: ${source}`);
  }
  entries.push({ source, destination, kind });
}

export function buildInstallGraph() {
  const entries = [];
  for (const root of ROOTS) {
    const base = path.join(repoRoot, root.source);
    for (const file of walkFiles(base)) {
      const relative = posix(path.relative(base, file));
      if (!root.extensions.includes(path.extname(file).toLowerCase())) continue;
      if ((root.exclude || []).some((pattern) => pattern.test(relative))) continue;
      addEntry(entries, posix(path.relative(repoRoot, file)), `${root.source}/${relative}`);
    }
  }

  for (const directory of FLAT_POWERSHELL_DIRS) {
    const base = path.join(repoRoot, directory);
    for (const file of fs.readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!file.isFile() || path.extname(file.name).toLowerCase() !== '.ps1') continue;
      addEntry(entries, `${directory}/${file.name}`, file.name, 'root-compat');
    }
  }

  entries.sort((a, b) => a.destination.localeCompare(b.destination) || a.source.localeCompare(b.source));
  const seen = new Map();
  for (const entry of entries) {
    if (seen.has(entry.destination)) throw new Error(`Duplicate installed destination: ${entry.destination}`);
    seen.set(entry.destination, entry.source);
  }
  validateImportClosure(entries);
  return { formatVersion: 1, generatedBy: 'scripts/generate-install-file-graph.mjs', entries };
}

function resolveDependency(sourcePath, specifier) {
  const raw = path.resolve(path.dirname(sourcePath), specifier);
  const candidates = path.extname(raw)
    ? [raw]
    : [raw, `${raw}.js`, `${raw}.mjs`, `${raw}.cjs`, `${raw}.json`, path.join(raw, 'index.js'), path.join(raw, 'index.mjs')];
  return candidates.find((candidate) => fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) || null;
}

export function validateImportClosure(entries) {
  const sourceToDestination = new Map(entries.map((entry) => [entry.source, entry.destination]));
  const patterns = [
    /(?:from\s+|import\s*\(|require\s*\(|new\s+URL\s*\()\s*["'](\.{1,2}\/[^"']+)["']/g,
  ];
  const failures = [];
  for (const entry of entries) {
    if (!/\.(?:js|mjs|cjs)$/.test(entry.source)) continue;
    const sourcePath = path.join(repoRoot, entry.source);
    const text = fs.readFileSync(sourcePath, 'utf8');
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const dependencyPath = resolveDependency(sourcePath, match[1]);
        if (!dependencyPath) continue;
        const dependencySource = posix(path.relative(repoRoot, dependencyPath));
        const expectedDestination = posix(path.relative(repoRoot, path.resolve(repoRoot, path.dirname(entry.destination), match[1]))) + (path.extname(match[1]) ? '' : path.extname(dependencyPath));
        const installedDestination = sourceToDestination.get(dependencySource);
        if (installedDestination !== expectedDestination) {
          failures.push(`${entry.destination} imports ${match[1]} but ${dependencySource} installs as ${installedDestination || '<missing>'}; expected ${expectedDestination}`);
        }
      }
    }
  }
  if (failures.length) throw new Error(`Installed import closure is incomplete:\n- ${failures.join('\n- ')}`);
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function runCli() {
  const graph = buildInstallGraph();
  const generated = stableJson(graph);
  if (checkOnly) {
    const existing = fs.readFileSync(outputPath, 'utf8');
    if (existing !== generated) {
      console.error('scripts/install-files.json is stale. Run node scripts/generate-install-file-graph.mjs');
      process.exitCode = 1;
      return;
    }
    console.log(`Install file graph is current (${graph.entries.length} files).`);
  } else {
    fs.writeFileSync(outputPath, generated, 'utf8');
    console.log(`Wrote ${path.relative(repoRoot, outputPath)} with ${graph.entries.length} files.`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli();
}
