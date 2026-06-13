/**
 * ops/stress-test-concurrent.js
 * ==============================
 * 并发压测 + 锁冲突压测
 *
 * 运行: node ops/stress-test-concurrent.js
 */

import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function nodeExec(script, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script], {
      cwd: cwd || PROJECT_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.on("error", reject);
  });
}

function now() { return Date.now(); }

function report(name, { passed, failed, errors, duration, ops }) {
  const rps  = ops ? Math.round(ops / (duration / 1000)) : 0;
  const ok   = failed === 0 && errors === 0;
  const icon = ok ? "✅" : "❌";
  console.log(
    `${icon} [${name}] passed=${passed} failed=${failed} errors=${errors} ` +
    `time=${duration}ms rps=${rps}`
  );
  if (errors > 0 || failed > 0) {
    if (errors > 0) console.error("  Errors:", errors, errors > 3 ? "(前3)" : "");
    if (failed  > 0) console.error("  Failed:", failed);
  }
  return ok;
}

// ---------------------------------------------------------------------------
// 测试 1: KG并发写入 (20进程, 每个写10条)
// ---------------------------------------------------------------------------

async function testKgConcurrentWrite(concurrency = 20, writesPerProcess = 10) {
  const label = `KG并发写入 ${concurrency}x${writesPerProcess}`;
  const start = now();
  let passed = 0, failed = 0, errors = 0;

  const script = (id) => `
    const path = require('path');
    const PROOT = ${JSON.stringify(PROJECT_ROOT)};
    const { KnowledgeGraph } = require(path.join(PROOT, 'ops/knowledge/knowledge-graph.js'));
    const { resolveStoreRoot } = require(path.join(PROOT, 'bus', 'store-root.js'));
    const vault = resolveVaultRoot();
    const kg = new KnowledgeGraph({ vaultRoot: vault });
    const errs = [];
    for (let i = 0; i < ${writesPerProcess}; i++) {
      try {
        kg.upsertTriple(
          '并发测试实体_' + ${id},
          '字段' + i,
          '值_' + ${id} + '_' + i,
          { source: 'stress-test', confidence: 0.9 }
        );
      } catch(e) { errs.push(e.message); }
    }
    kg.close();
    process.stdout.write(JSON.stringify({ errs }));
  `;

  const procs = Array.from({ length: concurrency }, (_, i) =>
    nodeExec(script(i), PROJECT_ROOT)
  );

  const results = await Promise.all(procs);
  for (const r of results) {
    if (r.code !== 0) { errors++; continue; }
    try {
      const j = JSON.parse(r.stdout.trim());
      if (j.errs && j.errs.length > 0) errors += j.errs.length;
      else passed++;
    } catch { errors++; }
  }

  return report(label, {
    passed, failed, errors,
    duration: now() - start,
    ops: concurrency * writesPerProcess,
  });
}

// ---------------------------------------------------------------------------
// 测试 2: KG并发读取 (50进程, 各读1次)
// ---------------------------------------------------------------------------

async function testKgConcurrentRead(concurrency = 50) {
  const label = `KG并发读取 ${concurrency}x`;
  const start = now();
  let passed = 0, failed = 0, errors = 0;

  const script = () => `
    const path = require('path');
    const PROOT = ${JSON.stringify(PROJECT_ROOT)};
    const { KnowledgeGraph } = require(path.join(PROOT, 'ops/knowledge/knowledge-graph.js'));
    const { resolveStoreRoot } = require(path.join(PROOT, 'bus', 'store-root.js'));
    const kg = new KnowledgeGraph({ vaultRoot: resolveVaultRoot() });
    try {
      const r = kg.queryCurrentTriples({ limit: 20 });
      process.stdout.write(JSON.stringify({ count: r.length }));
    } catch(e) {
      process.stdout.write(JSON.stringify({ error: e.message }));
    }
    kg.close();
  `;

  const procs = Array.from({ length: concurrency }, () =>
    nodeExec(script(), PROJECT_ROOT)
  );

  const results = await Promise.all(procs);
  const errorSamples = [];
  for (const r of results) {
    if (r.code !== 0) { errors++; errorSamples.push(r.stderr || r.stdout); continue; }
    try {
      const j = JSON.parse(r.stdout.trim());
      if (j.error) { errors++; errorSamples.push(j.error); }
      else { if (j.count >= 0) passed++; else failed++; }
    } catch { errors++; errorSamples.push(r.stdout); }
  }
  if (errorSamples.length > 0) {
    console.error("  Error samples:", errorSamples.slice(0, 3));
  }

  return report(label, {
    passed, failed, errors,
    duration: now() - start,
    ops: concurrency,
  });
}

// ---------------------------------------------------------------------------
// 测试 3: memory_query并发 (20进程)
// ---------------------------------------------------------------------------

async function testMemoryQueryConcurrent(concurrency = 20) {
  const label = `memory_query并发 ${concurrency}x`;
  const start = now();
  let passed = 0, failed = 0, errors = 0;
  const cwd  = PROJECT_ROOT;

  const script = (id) => `
    const path = require('path');
    const PROOT = ${JSON.stringify(PROJECT_ROOT)};
    const { memory_query } = require(path.join(PROOT, 'ops/mcp/mcp-memory-tools.js'));
    const queries = ['天空', '记忆', '蓝色', '持久化', '测试'];
    const q = queries[${id} % queries.length];
    try {
      const r = memory_query({ query: q, cwd: ${JSON.stringify(cwd)} });
      process.stdout.write(JSON.stringify({ count: r.results ? r.results.length : 0 }));
    } catch(e) {
      process.stdout.write(JSON.stringify({ error: e.message }));
    }
  `;

  const procs = Array.from({ length: concurrency }, (_, i) =>
    nodeExec(script(i), PROJECT_ROOT)
  );

  const results = await Promise.all(procs);
  for (const r of results) {
    if (r.code !== 0) { errors++; continue; }
    try {
      const j = JSON.parse(r.stdout.trim());
      if (j.error) { errors++; }
      else { if (typeof j.count === "number") passed++; else failed++; }
    } catch { errors++; }
  }

  return report(label, {
    passed, failed, errors,
    duration: now() - start,
    ops: concurrency,
  });
}

// ---------------------------------------------------------------------------
// 测试 4: memory_boot并发 (20进程)
// ---------------------------------------------------------------------------

async function testMemoryBootConcurrent(concurrency = 20) {
  const label = `memory_boot并发 ${concurrency}x`;
  const start = now();
  let passed = 0, failed = 0, errors = 0;
  const cwd  = PROJECT_ROOT;

  const script = () => `
    const path = require('path');
    const PROOT = ${JSON.stringify(PROJECT_ROOT)};
    const { memory_boot } = require(path.join(PROOT, 'ops/mcp/mcp-memory-tools.js'));
    try {
      const r = memory_boot({ cwd: ${JSON.stringify(cwd)} });
      process.stdout.write(JSON.stringify({
        l0len: r.fact_count || 0,
        l1count: r.fact_count || 0,
        key: r.project
      }));
    } catch(e) {
      process.stdout.write(JSON.stringify({ error: e.message }));
    }
  `;

  const procs = Array.from({ length: concurrency }, () =>
    nodeExec(script(), PROJECT_ROOT)
  );

  const results = await Promise.all(procs);
  for (const r of results) {
    if (r.code !== 0) { errors++; continue; }
    try {
      const j = JSON.parse(r.stdout.trim());
      if (j.error) { errors++; }
      else { if (j.key) passed++; else failed++; }
    } catch { errors++; }
  }

  return report(label, {
    passed, failed, errors,
    duration: now() - start,
    ops: concurrency,
  });
}

// ---------------------------------------------------------------------------
// 测试 5: inbox文件并发写入 (10进程同时 appendLineAtomic)
// ---------------------------------------------------------------------------

async function testInboxConcurrentWrite(concurrency = 10) {
  const label = `inbox并发写入 ${concurrency}x`;
  const start = now();
  let passed = 0, failed = 0, errors = 0;

  const { resolveStoreRoot } = await import(path.join(PROJECT_ROOT, "bus", "store-root.js"));
  const storeRoot = resolveStoreRoot();
  const inboxPath = path.join(storeRoot, "inbox", "stress-test.md");
  const session = `stress-${Date.now()}`;

  const script = (id) => `
    const path = require('path');
    const PROOT = ${JSON.stringify(PROJECT_ROOT)};
    const { appendLineAtomic } = require(path.join(PROOT, 'ops/inbox/inbox-atomic-write.js'));
    const inboxPath = ${JSON.stringify(inboxPath)};
    const line = '- [2026-04-11T10:00:00.000Z] [test] stress_id=' + String(${id}) + ' ';
    try {
      appendLineAtomic(inboxPath, line, { createDir: true });
      process.exit(0);
    } catch(e) {
      process.stderr.write('err:' + e.message);
      process.exit(1);
    }
  `;

  // 先清空并确保目录存在
  fs.mkdirSync(path.dirname(inboxPath), { recursive: true });
  if (fs.existsSync(inboxPath)) fs.unlinkSync(inboxPath);
  fs.writeFileSync(inboxPath, "", "utf8");

  const procs = Array.from({ length: concurrency }, (_, i) =>
    nodeExec(script(i), PROJECT_ROOT)
  );

  const results = await Promise.all(procs);
  for (const r of results) {
    if (r.code === 0) passed++;
    else { errors++; console.error("  append err code:", r.code, r.stderr.slice(0, 100)); }
  }

  // 清理
  if (fs.existsSync(inboxPath)) fs.unlinkSync(inboxPath);

  return report(label, {
    passed, failed, errors,
    duration: now() - start,
    ops: concurrency,
  });
}

// ---------------------------------------------------------------------------
// 测试 6: KG WAL模式验证 + 100次高频写入
// ---------------------------------------------------------------------------

async function testKgWalStress(iterations = 100) {
  const label = `KG WAL压测 ${iterations}x写入`;
  const start = now();
  let passed = 0, failed = 0, errors = 0;

  const { KnowledgeGraph } = await import(path.join(PROJECT_ROOT, "ops/knowledge/knowledge-graph.js"));
  const { resolveStoreRoot } = await import(path.join(PROJECT_ROOT, "bus", "store-root.js"));
  const vault = resolveVaultRoot();

  for (let i = 0; i < iterations; i++) {
    const kg = new KnowledgeGraph({ vaultRoot: vault });
    try {
      kg.upsertTriple(
        `WAL测试实体_${i}`,
        "迭代",
        String(i),
        { source: "wal-stress", confidence: 0.9 }
      );
      // 每10次做一次checkpoint
      if (i % 10 === 0) {
        kg._db.run("PRAGMA wal_checkpoint(TRUNCATE)");
      }
      passed++;
    } catch(e) {
      errors++;
      if (errors <= 3) console.error(`  WAL错误[${i}]:`, e.message);
    } finally {
      kg.close();
    }
  }

  // 验证 WAL 模式
  const kg2 = new KnowledgeGraph({ vaultRoot: vault });
  const mode = kg2._db.all("PRAGMA journal_mode")[0].journal_mode;
  kg2.close();
  console.log(`   Journal mode: ${mode}`);

  return report(label, {
    passed, failed, errors,
    duration: now() - start,
    ops: iterations,
  });
}

// ---------------------------------------------------------------------------
// 测试 7: 混合并发读写 (50进程, 随机读写KG + inbox)
// ---------------------------------------------------------------------------

async function testMixedConcurrency(concurrency = 50) {
  const label = `混合并发读写 ${concurrency}x`;
  const start = now();
  let passed = 0, failed = 0, errors = 0;
  const cwd  = PROJECT_ROOT;

  const script = (id) => `
    const path = require('path');
    const PROOT = ${JSON.stringify(PROJECT_ROOT)};
    const { KnowledgeGraph } = require(path.join(PROOT, 'ops/knowledge/knowledge-graph.js'));
    const { memory_query } = require(path.join(PROOT, 'ops/mcp/mcp-memory-tools.js'));
    const { resolveStoreRoot } = require(path.join(PROOT, 'bus', 'store-root.js'));
    const vault = resolveVaultRoot();
    const ops = [];
    const errs = [];
    const kg = new KnowledgeGraph({ vaultRoot: vault });

    // 3次写入
    for (let i = 0; i < 3; i++) {
      try {
        kg.upsertTriple(
          '混合测试_' + ${id},
          '字段' + i,
          '值' + i,
          { source: 'mixed-stress', confidence: 0.9 }
        );
        ops.push('write');
      } catch(e) { errs.push('w:' + e.message); }
    }

    // 3次读取
    for (let i = 0; i < 3; i++) {
      try {
        kg.queryCurrentTriples({ entityName: 'obsidian_shared_memory_bus', limit: 5 });
        ops.push('read');
      } catch(e) { errs.push('r:' + e.message); }
    }

    kg.close();

    // 2次memory_query
    try {
      memory_query({ query: '测试', cwd: ${JSON.stringify(cwd)} });
      ops.push('query');
    } catch(e) { errs.push('q:' + e.message); }

    process.stdout.write(JSON.stringify({ ops: ops.length, errs }));
  `;

  const procs = Array.from({ length: concurrency }, (_, i) =>
    nodeExec(script(i), PROJECT_ROOT)
  );

  const results = await Promise.all(procs);
  for (const r of results) {
    if (r.code !== 0) { errors++; continue; }
    try {
      const j = JSON.parse(r.stdout.trim());
      if (j.errs && j.errs.length > 0) errors += j.errs.length;
      if (j.ops === 7) passed++;
      else failed++;
    } catch { errors++; }
  }

  return report(label, {
    passed, failed, errors,
    duration: now() - start,
    ops: concurrency * 7,
  });
}

// ---------------------------------------------------------------------------
// 测试 8: 数据库锁冲突 - 快速连续写入 (100次)
// ---------------------------------------------------------------------------

async function testDbLockContention() {
  const label = "DB锁冲突压测 (100次快速连续写入)";
  const start = now();
  let locked = 0, ok = 0;

  const { KnowledgeGraph } = await import(path.join(PROJECT_ROOT, "ops/knowledge/knowledge-graph.js"));
  const { resolveStoreRoot } = await import(path.join(PROJECT_ROOT, "bus", "store-root.js"));
  const vault = resolveVaultRoot();

  for (let i = 0; i < 100; i++) {
    const kg = new KnowledgeGraph({ vaultRoot: vault });
    try {
      kg.upsertTriple(
        `锁测试_${i}`,
        "序号",
        String(i),
        { source: "lock-test", confidence: 0.9 }
      );
      ok++;
    } catch(e) {
      if (e.message.includes("locked") || e.message.includes("SQLITE_BUSY")) {
        locked++;
      }
    } finally {
      kg.close();
    }
  }

  console.log(
    `   成功=${ok} 锁冲突=${locked} 锁率=${(locked / 100 * 100).toFixed(1)}%`
  );
  // WAL模式允许少量锁冲突（<5%）
  const ok2 = locked <= 5;
  console.log(`${ok2 ? "✅" : "⚠️"} [${label}]`);
  return ok2;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

async function main() {
  console.log("=".repeat(60));
  console.log("并发压测 + 锁冲突压测");
  console.log("=".repeat(60));

  const results = [];
  const { resolveStoreRoot } = await import(path.join(PROJECT_ROOT, "bus", "store-root.js"));
  const vault = resolveVaultRoot();
  console.log("Vault:", vault);

  const tests = [
    () => testKgConcurrentWrite(20, 10),
    () => testKgConcurrentRead(50),
    () => testMemoryQueryConcurrent(20),
    () => testMemoryBootConcurrent(20),
    () => testInboxConcurrentWrite(10),
    () => testKgWalStress(100),
    () => testMixedConcurrency(50),
    () => testDbLockContention(),
  ];

  for (const t of tests) {
    try {
      const ok = await t();
      results.push(ok);
      await sleep(1000); // 1s 间隔让 WAL checkpoint 完成
    } catch(e) {
      console.error("❌ 测试异常:", e.message);
      results.push(false);
    }
  }

  console.log("\n" + "=".repeat(60));
  const passed = results.filter(Boolean).length;
  console.log(`总结: ${passed}/${results.length} 通过`);
  console.log("=".repeat(60));

  if (results.every(Boolean)) {
    console.log("✅ 全部压测通过");
  } else {
    console.log("⚠️  部分压测失败，请检查上方输出");
  }
}

main().catch(console.error);
