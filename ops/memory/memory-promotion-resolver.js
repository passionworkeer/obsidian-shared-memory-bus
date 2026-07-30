#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  applyResolvedPromotions,
  buildConflictGraph,
  compareEntries,
  findRecordSourceFile,
  getHumanReviewQueue,
  getLastAccess,
  resolveConflicts,
  resolveQueue,
} from './memory-promotion-resolver-core.mjs';

function optionValue(args, flag, fallback = null) {
  const index = args.indexOf(flag);
  if (index === -1) return fallback;
  const next = args[index + 1];
  return next === undefined || next.startsWith('-') ? true : next;
}

function readJsonl(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function runPromotionResolver(argv = process.argv.slice(2), env = process.env) {
  const storeRoot = optionValue(argv, '--store-root', env.AI_MEMORY_STORE || null);
  const dryRun = Boolean(optionValue(argv, '--dry-run', false));
  if (!storeRoot || storeRoot === true) {
    throw new Error('--store-root or AI_MEMORY_STORE is required');
  }

  const defaultQueue = path.join(String(storeRoot), '.ai-memory', 'queue', 'promotion-queue.jsonl');
  const queuePath = optionValue(argv, '--queue', defaultQueue);
  if (!queuePath || queuePath === true) {
    throw new Error('--queue requires a path');
  }

  console.log(`[promotion-resolver] Starting promotion resolver (dry_run=${dryRun})`);
  console.log(`[promotion-resolver] Queue: ${queuePath}`);
  const result = resolveQueue(String(queuePath));

  if (!dryRun && result.resolved_path && fs.existsSync(result.resolved_path)) {
    const applied = applyResolvedPromotions(readJsonl(result.resolved_path));
    console.log(`[promotion-resolver] Applied promotions: ${JSON.stringify(applied)}`);
  }

  console.log('[promotion-resolver] Done.');
  return result;
}

const isDirectRun = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;

if (isDirectRun) {
  try {
    runPromotionResolver();
  } catch (error) {
    console.error(`[promotion-resolver] ${error.message}`);
    process.exitCode = 1;
  }
}

export {
  getLastAccess,
  compareEntries,
  buildConflictGraph,
  resolveConflicts,
  resolveQueue,
  getHumanReviewQueue,
  applyResolvedPromotions,
  findRecordSourceFile,
};
