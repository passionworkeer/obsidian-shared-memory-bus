/**
 * Q-HIGH-1 step 5.1 — 守护 search_text_utils.py 拆分契约(Node.js test runner)。
 *
 * 按 docs/reference/q-high-1-step-5-design.md §3.1:
 *   search_ranking.py 把 tokenize / normalize_spaces / is_noise /
 *   derive_entry_layer + 6 个常量 + _load_structured_files 抽到
 *   retrieval/search_text_utils.py。
 *
 * 断言锁死:
 *   - search_text_utils.py 存在
 *   - `python -c "import search_text_utils, search_ranking; X is Y"` 对每个
 *     公开符号都成立(ref identity 相等),证明 re-export 单源不变
 *   - search_ranking.py 已不再 inline 定义 NOISE_PATTERNS / tokenize /
 *     derive_entry_layer(防回退)
 *   - STRUCTURED_FILES 加载成功、is_noise/derive_entry_layer 行为对等
 *   - search_ranking.py 行数已 < 1300 (从 1357 抽走 ~150 行)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const RETRIEVAL_DIR = path.resolve(
  path.dirname(__filename),
  "../../../retrieval",
);
const REPO_ROOT = path.resolve(RETRIEVAL_DIR, "..");

function runPython(code) {
  // 用 repo root 作为 cwd 这样检索 + import 路径与生产一致
  return execFileSync(
    process.env.AI_MEMORY_PYTHON || "python",
    ["-c", code],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

const EXPECTED_PUBLIC_SYMBOLS = [
  "BM25Okapi",
  "DURABLE_QUERY_PATTERN",
  "DURABLE_SCOPES",
  "KNOWN_LAYERS",
  "NOISE_PATTERNS",
  "RECENT_QUERY_PATTERN",
  "REFERENCE_QUERY_PATTERN",
  "ROUTE_VALUES",
  "STRUCTURED_FILES",
  "TASK_QUERY_PATTERN",
  "derive_entry_layer",
  "is_noise",
  "jieba",
  "normalize_spaces",
  "tokenize",
];

test("retrieval/search_text_utils.py file exists", () => {
  const filePath = path.join(RETRIEVAL_DIR, "search_text_utils.py");
  assert.ok(fs.existsSync(filePath), `${filePath} must exist (Q-HIGH-1 step 5.1 split target)`);
});

test("retrieval/search_text_utils.py exports all expected symbols", () => {
  const probe = EXPECTED_PUBLIC_SYMBOLS.map((s) => `hasattr(stu, ${JSON.stringify(s)})`).join(" and ");
  const code = `import sys; sys.path.insert(0, r'${RETRIEVAL_DIR.replace(/\\/g, "/")}'); import search_text_utils as stu; assert ${probe}; print('OK')`;
  const out = runPython(code).trim();
  assert.equal(out, "OK");
});

test("retrieval/search_ranking.py re-exports each symbol with identity equal to search_text_utils", () => {
  const checks = EXPECTED_PUBLIC_SYMBOLS
    .map((s) => `sr.${s} is stu.${s}`)
    .join(" and ");
  const code = `import sys; p = r'${RETRIEVAL_DIR.replace(/\\/g, "/")}'; sys.path.insert(0, p); import search_text_utils as stu; import search_ranking as sr; assert ${checks}; print('OK')`;
  const out = runPython(code).trim();
  assert.equal(out, "OK");
});

test("retrieval/search_ranking.py no longer inline-defines NOISE_PATTERNS list", () => {
  const src = fs.readFileSync(path.join(RETRIEVAL_DIR, "search_ranking.py"), "utf8");
  // 不应有 "NOISE_PATTERNS = [" 这种 top-level 字面定义
  assert.ok(
    !/^NOISE_PATTERNS\s*=\s*\[/m.test(src),
    "search_ranking.py still inline-defines NOISE_PATTERNS list",
  );
});

test("retrieval/search_ranking.py no longer defines tokenize()", () => {
  const src = fs.readFileSync(path.join(RETRIEVAL_DIR, "search_ranking.py"), "utf8");
  assert.ok(
    !/^def tokenize\(/m.test(src),
    "search_ranking.py still defines tokenize(); should come from search_text_utils",
  );
});

test("retrieval/search_ranking.py no longer defines derive_entry_layer()", () => {
  const src = fs.readFileSync(path.join(RETRIEVAL_DIR, "search_ranking.py"), "utf8");
  assert.ok(
    !/^def derive_entry_layer\(/m.test(src),
    "search_ranking.py still defines derive_entry_layer(); should come from search_text_utils",
  );
});

test("STRUCTURED_FILES is a non-empty list including shared-inbox.jsonl", () => {
  const code = `import sys; p = r'${RETRIEVAL_DIR.replace(/\\/g, "/")}'; sys.path.insert(0, p); import search_text_utils as stu; assert isinstance(stu.STRUCTURED_FILES, list); assert len(stu.STRUCTURED_FILES) > 0; assert 'shared-inbox.jsonl' in stu.STRUCTURED_FILES; print('OK')`;
  const out = runPython(code).trim();
  assert.equal(out, "OK");
});

test("tokenize() dedupes + behaves as expected", () => {
  const code = `import sys; p = r'${RETRIEVAL_DIR.replace(/\\/g, "/")}'; sys.path.insert(0, p); import search_text_utils as stu; toks = stu.tokenize('hello hello world'); assert toks.count('hello') == 1, toks; assert 'world' in toks; print('OK')`;
  const out = runPython(code).trim();
  assert.equal(out, "OK");
});

test("is_noise() flags short / empty text as noise", () => {
  const code = `import sys; p = r'${RETRIEVAL_DIR.replace(/\\/g, "/")}'; sys.path.insert(0, p); import search_text_utils as stu; assert stu.is_noise('hi') is True; assert stu.is_noise('') is True; print('OK')`;
  const out = runPython(code).trim();
  assert.equal(out, "OK");
});

test("derive_entry_layer() returns expected layer strings", () => {
  const code = `import sys; p = r'${RETRIEVAL_DIR.replace(/\\/g, "/")}'; sys.path.insert(0, p); import search_text_utils as stu; assert stu.derive_entry_layer({'memory_level': 'task'}) == 'task'; assert stu.derive_entry_layer({'memory_level': 'durable'}) == 'durable'; assert stu.derive_entry_layer({}) == 'session'; print('OK')`;
  const out = runPython(code).trim();
  assert.equal(out, "OK");
});

test("search_ranking.py line count < 1300 after step 5.1 (was 1357)", () => {
  const src = fs.readFileSync(path.join(RETRIEVAL_DIR, "search_ranking.py"), "utf8");
  const lineCount = src.split(/\r?\n/).length;
  assert.ok(
    lineCount < 1300,
    `search_ranking.py is ${lineCount} lines after step 5.1; expected < 1300 (was 1357)`,
  );
});
