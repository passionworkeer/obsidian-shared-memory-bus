#!/usr/bin/env node

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/i;
const WORKFLOW_EXTENSIONS = new Set(['.yml', '.yaml']);

function unquote(value) {
  const first = value[0];
  const last = value.at(-1);
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

function parseUsesValue(line) {
  const match = line.match(/^\s*(?:-\s*)?uses:\s*(.+?)\s*$/);
  if (!match) return null;
  const withoutComment = match[1].replace(/\s+#.*$/, '').trim();
  return unquote(withoutComment);
}

export function findUnpinnedActionRefs(text, filePath = '<workflow>') {
  const violations = [];
  const lines = text.split(/\r?\n/);

  lines.forEach((line, index) => {
    const actionRef = parseUsesValue(line);
    if (!actionRef || actionRef.startsWith('./')) return;

    const separator = actionRef.lastIndexOf('@');
    const revision = separator > 0 ? actionRef.slice(separator + 1) : '';
    if (separator > 0 && FULL_COMMIT_SHA.test(revision)) return;

    violations.push({
      filePath,
      line: index + 1,
      actionRef,
      message: 'external GitHub Actions must use a full 40-character commit SHA',
    });
  });

  return violations;
}

async function listWorkflowFiles(rootDir) {
  const workflowDir = path.join(rootDir, '.github', 'workflows');
  const entries = await readdir(workflowDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && WORKFLOW_EXTENSIONS.has(path.extname(entry.name)))
    .map((entry) => path.join(workflowDir, entry.name))
    .sort();
}

export async function checkActionPins(rootDir = process.cwd()) {
  const files = await listWorkflowFiles(rootDir);
  const violations = [];

  for (const filePath of files) {
    const text = await readFile(filePath, 'utf8');
    const relativePath = path.relative(rootDir, filePath).split(path.sep).join('/');
    violations.push(...findUnpinnedActionRefs(text, relativePath));
  }

  return violations;
}

async function main() {
  const violations = await checkActionPins();
  if (violations.length === 0) {
    console.log('All external GitHub Actions are pinned to immutable commit SHAs.');
    return;
  }

  for (const violation of violations) {
    console.error(`${violation.filePath}:${violation.line}: ${violation.actionRef} — ${violation.message}`);
  }
  process.exitCode = 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (fileURLToPath(import.meta.url) === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
