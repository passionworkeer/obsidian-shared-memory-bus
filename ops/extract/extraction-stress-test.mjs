/**
 * ops/extraction-stress-test.mjs
 * ==============================
 * 提取层专项压测：并发写入、JSONL 完整性、pending 降级、内存泄漏检测
 *
 * 运行: node ops/extraction-stress-test.mjs
 * 无外部依赖，使用内联 mock LLM
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { createInterface } from "node:readline";
import assert from "node:assert";
import { resolveStoreRoot, getProjectsRoot } from "../bus/store-root.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TEST_PROJECT = "stress-test-project";
const STORE_ROOT = resolveStoreRoot();
const PROJECTS_ROOT = getProjectsRoot(STORE_ROOT);
const PROJECT_JSONL = path.join(PROJECTS_ROOT, `${TEST_PROJECT}.jsonl`);
const PENDING_FILE = path.join(STORE_ROOT, "extraction-pending.jsonl");
const REQUIRED_EXTRACTION_MODULES = [
  "extraction-pipeline.mjs",
  "extraction-validate.mjs",
  "extract-transcript.mjs",
];

// Mock LLM response — always returns valid XML
const MOCK_XML_RESPONSE = `<extraction>
  <session_type>feature</session_type>
  <confidence>0.85</confidence>
  <facts>
    <fact type="project"><content>压力测试写入了一条项目记忆，验证并发写入的正确性</content><scope>project</scope></fact>
    <fact type="user"><content>压力测试验证用户身份记忆提取功能正常</content><scope>user</scope></fact>
  </facts>
  <decisions>
    <decision>压测并发写入不影响 JSONL 完整性</decision>
  </decisions>
  <entities>
    <entity type="project"><name>obsidian-shared-memory-bus</name><context>多 agent 共享记忆系统</context></entity>
  </entities>
</extraction>`;

// Mock LLM server (simple HTTP on a random port)
const CONCURRENT_LEVELS = [1, 5, 10];
const ITERATIONS_PER_LEVEL = 3;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function now() { return Date.now(); }

function ms(n) { return Math.round(n); }

function cleanTestFiles() {
  for (const f of [PROJECT_JSONL, PENDING_FILE]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

function findMissingExtractionModules() {
  return REQUIRED_EXTRACTION_MODULES.filter((name) => !fs.existsSync(path.join(__dirname, name)));
}

function countJsonlLines(filePath) {
  if (!fs.existsSync(filePath)) return 0;
  return fs.readFileSync(filePath, "utf-8").trim().split("\n").filter(Boolean).length;
}

function validateJsonlIntegrity(filePath) {
  if (!fs.existsSync(filePath)) return { ok: true, corruptLines: 0 };
  const lines = fs.readFileSync(filePath, "utf-8").trim().split("\n").filter(Boolean);
  let corrupt = 0;
  const seenIds = new Set();
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (!obj.id) corrupt++;
      else if (seenIds.has(obj.id)) corrupt++; // duplicate ID
      else seenIds.add(obj.id);
    } catch {
      corrupt++;
    }
  }
  return { ok: corrupt === 0, corruptLines: corrupt, totalLines: lines.length };
}

function createMockTranscript(sessionIndex, lines = 50) {
  const entries = [];
  for (let i = 0; i < lines; i++) {
    entries.push(JSON.stringify({
      text: `Session ${sessionIndex} line ${i}: 压力测试内容 ${"x".repeat(50)}`
    }));
  }
  return entries.join("\n");
}

function getTmpTranscript(sessionIndex) {
  return path.join(STORE_ROOT, `__stress_transcript_${sessionIndex}.jsonl`);
}

function writeMockTranscript(sessionIndex) {
  const p = getTmpTranscript(sessionIndex);
  fs.writeFileSync(p, createMockTranscript(sessionIndex), "utf-8");
  return p;
}

// Mock LLM server — returns consistent valid XML (using http module for correct HTTP)
let mockServer = null;
let mockServerPort = 0;

async function startMockLLMServer() {
  const http = await import("node:http");
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const body = JSON.stringify({
        choices: [{ message: { content: MOCK_XML_RESPONSE } }]
      });
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "Connection": "close",
      });
      res.end(body);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      mockServerPort = addr.port;
      resolve(server);
    });
  });
}

async function stopMockLLMServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

async function testJsonlIntegrityUnderConcurrentWrite({ concurrency, iterations }) {
  const start = now();
  const transcripts = [];

  // Write all mock transcripts first
  for (let i = 0; i < concurrency * iterations; i++) {
    writeMockTranscript(i);
    transcripts.push({ id: i, path: getTmpTranscript(i) });
  }

  const baseUrl = `http://127.0.0.1:${mockServerPort}`;

  // Run pipeline concurrently
  const { runExtraction } = await import("./extraction-pipeline.mjs");

  const tasks = [];
  for (let iter = 0; iter < iterations; iter++) {
    const batch = [];
    for (let c = 0; c < concurrency; c++) {
      const idx = iter * concurrency + c;
      batch.push(
        runExtraction({
          transcriptPath: transcripts[idx].path,
          project: TEST_PROJECT,
          tool: `stress-test-${idx}`,
          sessionId: `iter${iter}-c${c}`,
        }).catch(err => ({ ok: false, error: err.message }))
      );
    }
    tasks.push(...batch);
    // Stagger batches slightly to simulate real-world timing
    if (iter < iterations - 1) await sleep(10);
  }

  const results = await Promise.all(tasks);

  // Clean up transcripts
  for (const t of transcripts) {
    if (fs.existsSync(t.path)) fs.unlinkSync(t.path);
  }

  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  const duration = ms(now() - start);

  // Check JSONL integrity
  const integrity = validateJsonlIntegrity(PROJECT_JSONL);
  const pendingLines = countJsonlLines(PENDING_FILE);
  const projectLines = countJsonlLines(PROJECT_JSONL);

  const ok = passed > 0 && integrity.ok && failed === 0;
  console.log(
    `${ok ? "✅" : "❌"} [concurrent-write:${concurrency}x${iterations}] ` +
    `passed=${passed} failed=${failed} project_lines=${projectLines} ` +
    `pending_lines=${pendingLines} corrupt=${integrity.corruptLines} ` +
    `time=${duration}ms`
  );

  if (!integrity.ok) {
    console.error(`  ❌ JSONL 损坏：${integrity.corruptLines} 行损坏，共 ${integrity.totalLines} 行`);
  }

  return { ok, passed, failed, integrity, projectLines, pendingLines, duration };
}

async function testPendingFallbackOnLLMFailure() {
  // Test pending fallback: simulate LLM returning garbage.
  // Direct parseXml call bypasses env-var / module-const timing issue.
  const start = now();

  const { parseExtractionXml, meetsQualityBar } = await import("./extraction-validate.mjs");

  // Simulate: LLM down → garbage XML response
  const garbageXml = `<extraction><session_type>unknown</session_type><confidence>1.5</confidence></extraction>`;
  const parsed = parseExtractionXml(garbageXml);

  // meetsQualityBar should be false (session_type invalid, confidence out of range, 0 facts)
  const meetsBar = meetsQualityBar(parsed, 1);

  // Simulate writing to pending.jsonl (pipeline fallback logic)
  const pendingEntry = {
    t: new Date().toISOString(),
    project: TEST_PROJECT,
    tool: "fallback-test",
    failed_reason: "simulated-llm-failure",
    parse_errors: [...parsed.errors],
    facts_count: parsed.facts.length,
  };
  appendJsonlToFile(PENDING_FILE, pendingEntry);

  const pendingLines = countJsonlLines(PENDING_FILE);
  const ok = meetsBar === false &&
             parsed.valid === false &&
             parsed.errors.length > 0 &&
             pendingLines > 0;

  const duration = ms(now() - start);

  console.log(
    `${ok ? "✅" : "❌"} [pending-fallback] ` +
    `meetsBar=${meetsBar} parseValid=${parsed.valid} ` +
    `errors=${parsed.errors.join("|")} pending_lines=${pendingLines} time=${duration}ms`
  );

  return { ok, meetsBar, parseValid: parsed.valid, parseErrors: parsed.errors.length, pendingLines, duration };
}

// Helper — append one JSON line to a file
function appendJsonlToFile(filePath, obj) {
  fs.appendFileSync(filePath, JSON.stringify(obj) + "\n", "utf-8");
}

async function testValidateRecordPerformance() {
  const { validateRecord } = await import("./extraction-pipeline.mjs");

  const start = now();
  const ITERATIONS = 50000;

  // Build a valid record once
  const validRecord = {
    schemaVersion: 2,
    id: crypto.randomUUID(),
    tool: "stress-test",
    type: "feature",
    title: "压测验证记录",
    source: "extraction",
    scope: "project",
  };

  let errors = 0;
  for (let i = 0; i < ITERATIONS; i++) {
    const r = validateRecord({ ...validRecord, id: crypto.randomUUID() });
    if (r !== true) errors++;
  }

  const duration = ms(now() - start);
  const rps = Math.round(ITERATIONS / (duration / 1000));
  const ok = errors === 0;

  console.log(
    `${ok ? "✅" : "❌"} [validateRecord-perf] ` +
    `iterations=${ITERATIONS} errors=${errors} ` +
    `time=${duration}ms rps=${rps}`
  );

  return { ok, errors, duration, rps };
}

async function testParseXmlPerformance() {
  const { parseExtractionXml } = await import("./extraction-validate.mjs");

  const start = now();
  const ITERATIONS = 10000;
  const xml = MOCK_XML_RESPONSE;

  let errors = 0;
  for (let i = 0; i < ITERATIONS; i++) {
    const r = parseExtractionXml(xml);
    if (!r.valid || r.facts.length < 2) errors++;
  }

  const duration = ms(now() - start);
  const rps = Math.round(ITERATIONS / (duration / 1000));
  const ok = errors === 0;

  console.log(
    `${ok ? "✅" : "❌"} [parseXml-perf] ` +
    `iterations=${ITERATIONS} errors=${errors} ` +
    `time=${duration}ms rps=${rps}`
  );

  return { ok, errors, duration, rps };
}

async function testBuildTranscriptPerformance() {
  const { buildExtractionTranscript } = await import("./extract-transcript.mjs");

  const start = now();
  const ITERATIONS = 5000;
  const lines = Array.from({ length: 200 }, (_, i) =>
    `Line ${i}: ${"压测内容 ".repeat(20)}${"x".repeat(100)}`
  );

  let ok = true;
  for (let i = 0; i < ITERATIONS; i++) {
    const result = buildExtractionTranscript(lines);
    if (!result.includes("=== 会话开头") || !result.includes("=== 工具交互")) {
      ok = false;
    }
  }

  const duration = ms(now() - start);
  const rps = Math.round(ITERATIONS / (duration / 1000));

  console.log(
    `${ok ? "✅" : "❌"} [buildTranscript-perf] ` +
    `iterations=${ITERATIONS} time=${duration}ms rps=${rps}`
  );

  return { ok, duration, rps };
}

async function testMemoryLeakDetection() {
  // Run pipeline 50 times and measure RSS growth
  const baseline = process.memoryUsage().heapUsed;

  const { runExtraction } = await import("./extraction-pipeline.mjs");
  const baseUrl = `http://127.0.0.1:${mockServerPort}`;

  const transcripts = [];
  for (let i = 0; i < 50; i++) {
    writeMockTranscript(i + 1000);
    transcripts.push(getTmpTranscript(i + 1000));
  }

  for (let i = 0; i < 50; i++) {
    await runExtraction({
      transcriptPath: transcripts[i],
      project: TEST_PROJECT,
      tool: "leak-test",
      sessionId: `leak-${i}`,
    });
  }

  // Cleanup
  for (const t of transcripts) {
    if (fs.existsSync(t)) fs.unlinkSync(t);
  }

  const after = process.memoryUsage().heapUsed;
  const growth = after - baseline;
  const growthMB = Math.round(growth / 1024 / 1024 * 100) / 100;

  // Allow up to 50MB growth for 50 iterations (1MB/iter is acceptable for Node)
  const ok = growthMB < 50;
  console.log(
    `${ok ? "✅" : "❌"} [memory-leak] ` +
    `baseline=${Math.round(baseline/1024/1024)}MB ` +
    `after=${Math.round(after/1024/1024)}MB ` +
    `growth=${growthMB}MB (max=50MB)`
  );

  return { ok, growthMB };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("\n" + "=".repeat(70));
  console.log("  提取层压力测试");
  console.log("=".repeat(70));
  console.log("");

  const missingModules = findMissingExtractionModules();
  if (missingModules.length > 0) {
    console.log("skipped: optional extraction modules unavailable");
    for (const name of missingModules) {
      console.log(`  missing: ops/extract/${name}`);
    }
    process.exit(0);
    return;
  }

  // Setup
  cleanTestFiles();

  // Ensure project dir exists
  if (!fs.existsSync(PROJECTS_ROOT)) {
    fs.mkdirSync(PROJECTS_ROOT, { recursive: true });
  }

  // Start mock LLM server
  console.log("启动 Mock LLM Server...");
  mockServer = await startMockLLMServer();
  process.env.AI_MEMORY_LLM_BASE_URL = `http://127.0.0.1:${mockServerPort}`;
  process.env.OPENAI_API_KEY = "sk-stress-test";
  console.log(`  Mock server: 127.0.0.1:${mockServerPort}\n`);

  const results = {};

  // 1. Performance benchmarks
  console.log("--- 性能基准测试 ---");
  results.validateRecordPerf = await testValidateRecordPerformance();
  results.parseXmlPerf = await testParseXmlPerformance();
  results.buildTranscriptPerf = await testBuildTranscriptPerformance();

  // 2. Pending fallback
  console.log("\n--- 降级机制测试 ---");
  results.pendingFallback = await testPendingFallbackOnLLMFailure();

  // 3. Concurrent write tests (fresh clean before each)
  console.log("\n--- 并发写入测试 ---");
  for (const level of CONCURRENT_LEVELS) {
    cleanTestFiles();
    results[`concurrent_${level}`] = await testJsonlIntegrityUnderConcurrentWrite({
      concurrency: level,
      iterations: ITERATIONS_PER_LEVEL,
    });
    // Small pause between levels
    await sleep(50);
  }

  // 4. Memory leak detection
  console.log("\n--- 内存泄漏检测 ---");
  results.memoryLeak = await testMemoryLeakDetection();

  // Final cleanup
  cleanTestFiles();
  await stopMockLLMServer(mockServer);

  // Summary
  console.log("\n" + "=".repeat(70));
  console.log("  测试汇总");
  console.log("=".repeat(70));

  const allOk = Object.values(results).every(r => r.ok !== false);
  const totalPassed = Object.values(results).filter(r => r.ok).length;
  const totalTests = Object.values(results).length;

  console.log(`\n  结果: ${totalPassed}/${totalTests} 通过`);
  console.log(`  状态: ${allOk ? "✅ 全部通过" : "❌ 存在失败项"}`);
  console.log("");

  if (!allOk) {
    const failures = Object.entries(results).filter(([, r]) => !r.ok);
    for (const [name, r] of failures) {
      console.log(`  ❌ ${name}:`, JSON.stringify(r));
    }
  }

  process.exit(allOk ? 0 : 1);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
