#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  buildPromotionQueue,
  buildTokenFingerprint,
  computeOverlap,
  detectConflicts,
  scoreAllCandidates,
  scoreConfidence,
  scoreCrossSessionHits,
  scorePromotionCandidate,
  scoreRecency,
  scoreSourceQuality,
  tokenize,
} from './memory-promotion-scorer-core.mjs';

function optionValue(args, flag, fallback = null) {
  const index = args.indexOf(flag);
  if (index === -1) return fallback;
  const next = args[index + 1];
  return next === undefined || next.startsWith('-') ? true : next;
}

function parseJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
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

function loadStructuredRecords(storeRoot) {
  const structuredRoot = path.join(storeRoot, 'structured');
  if (!fs.existsSync(structuredRoot)) return [];
  return fs.readdirSync(structuredRoot)
    .filter((fileName) => fileName.endsWith('.jsonl') && !fileName.startsWith('archive-'))
    .flatMap((fileName) => parseJsonl(path.join(structuredRoot, fileName)));
}

export function runPromotionScorer(argv = process.argv.slice(2), env = process.env) {
  const storeRoot = optionValue(argv, '--store-root', env.AI_MEMORY_STORE || null);
  const dryRun = Boolean(optionValue(argv, '--dry-run', false));
  if (!storeRoot || storeRoot === true) {
    throw new Error('--store-root or AI_MEMORY_STORE is required');
  }

  console.log(`[promotion-scorer] Starting promotion scorer (dry_run=${dryRun}, store=${storeRoot})`);
  const records = loadStructuredRecords(String(storeRoot));
  if (records.length === 0) {
    console.log('[promotion-scorer] No records found — nothing to score.');
    return { written: 0, records: 0 };
  }

  const scored = scoreAllCandidates(records);
  const withConflicts = detectConflicts(scored, records);
  console.log(`[promotion-scorer] Scored ${withConflicts.length} promotion candidates`);
  const result = buildPromotionQueue(withConflicts);
  console.log(`[promotion-scorer] Done. Queue written to: ${result.path}`);
  return { ...result, records: records.length };
}

const isDirectRun = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;

if (isDirectRun) {
  try {
    runPromotionScorer();
  } catch (error) {
    console.error(`[promotion-scorer] ${error.message}`);
    process.exitCode = 1;
  }
}

export {
  tokenize,
  buildTokenFingerprint,
  computeOverlap,
  scoreRecency,
  scoreConfidence,
  scoreCrossSessionHits,
  scoreSourceQuality,
  scorePromotionCandidate,
  scoreAllCandidates,
  detectConflicts,
  buildPromotionQueue,
};
