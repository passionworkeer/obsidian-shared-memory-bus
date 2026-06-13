/**
 * ops/bench/bench-detect-conflicts.js
 * ====================================
 * Performance monitor for `detectConflicts` (ops/memory/memory-contract.js).
 *
 * The current implementation is O(n²) in record count. The 50k-record cliff
 * was flagged in the deep analysis report as a known risk. This bench:
 *   1. Generates synthetic records at increasing sizes (1k, 5k, 10k, 25k).
 *   2. Runs detectConflicts and reports duration + ops/sec.
 *   3. Fails (exit 1) if any tier exceeds the configured threshold.
 *
 * Usage:
 *   node ops/bench/bench-detect-conflicts.js
 *   CI=1 node ops/bench/bench-detect-conflicts.js   # enforce threshold
 *
 * Thresholds are intentionally generous — detectConflicts at personal-memory
 * scale (≤10k records) should complete in well under 5s on commodity hardware.
 * The 25k and 50k tiers are the early-warning cliff. Bump the threshold and
 * open an issue when the 10k tier starts creeping past 5s.
 */

import { detectConflicts } from "../memory/memory-contract.js";

const TIERS = [
  { label: "1k",   count: 1_000,  budgetMs: 500 },
  { label: "5k",   count: 5_000,  budgetMs: 2_000 },
  { label: "10k",  count: 10_000, budgetMs: 5_000 },
  { label: "25k",  count: 25_000, budgetMs: 25_000 },
];

// Synthetic record factory: each record has random 5-15 word content so
// fingerprints vary but the workload shape matches real data.
function makeRecord(i) {
  const wordCount = 5 + Math.floor(Math.random() * 10);
  const words = [];
  for (let w = 0; w < wordCount; w++) {
    words.push("word" + Math.floor(Math.random() * 5000));
  }
  return {
    id: `rec-${i}`,
    title: words.slice(0, 3).join(" "),
    content: words.join(" "),
    facts: [],
    decisions: [],
  };
}

const enforce = process.env.CI === "1";
let failed = 0;
console.log("tier\trecords\tduration\tops/sec\tbudget\tstatus");
for (const tier of TIERS) {
  const records = Array.from({ length: tier.count }, (_, i) => makeRecord(i));
  const start = process.hrtime.bigint();
  const result = detectConflicts(records);
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  const opsPerSec = Math.round(tier.count / (elapsedMs / 1000));
  const overBudget = elapsedMs > tier.budgetMs;
  const status = overBudget ? "OVER" : "ok";
  if (overBudget) failed += 1;
  console.log(
    `${tier.label}\t${tier.count}\t${elapsedMs.toFixed(0)}ms\t${opsPerSec}\t${tier.budgetMs}ms\t${status}`
  );
  // Touch result to avoid dead-code elimination in future engine swaps.
  if (result.length !== tier.count) {
    console.error(`detectConflicts returned ${result.length} entries, expected ${tier.count}`);
    process.exit(1);
  }
}

if (failed > 0) {
  console.error(`\n${failed} tier(s) exceeded budget. See ops/memory/memory-contract.js detectConflicts (O(n²) over records).`);
  if (enforce) process.exit(1);
}
console.log("\n(All tiers within budget. Set CI=1 to enforce.)");
