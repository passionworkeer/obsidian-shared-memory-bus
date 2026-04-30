import test from "node:test";
import assert from "node:assert/strict";
import { buildPythonSearchArgs, parseCliArgs } from "../../../retrieval/semantic-search-cli.js";

test("parseCliArgs keeps OpenClaw route and filter flags separate from the query", () => {
  const parsed = parseCliArgs([
    "--json",
    "--mode",
    "hybrid",
    "--route",
    "task",
    "--tool",
    "openclaw",
    "--source-kind",
    "blackboard",
    "--top-k",
    "3",
    "shrimp intel queue",
  ]);

  assert.equal(parsed.jsonOnly, true);
  assert.equal(parsed.serverMode, false);
  assert.equal(parsed.mode, "hybrid");
  assert.equal(parsed.topK, 3);
  assert.deepEqual(parsed.forwardArgs, [
    "--mode",
    "hybrid",
    "--route",
    "task",
    "--tool",
    "openclaw",
    "--source-kind",
    "blackboard",
    "--top-k",
    "3",
  ]);
  assert.deepEqual(parsed.queryParts, ["shrimp intel queue"]);
});

test("parseCliArgs normalizes aliases and inline option values", () => {
  const parsed = parseCliArgs([
    "--mode=hybrid",
    "--route=task",
    "--tool=openclaw",
    "--sourceKind=blackboard",
    "--taskState=FAILED",
    "--preferSummaries",
    "shrimp queue",
  ]);

  assert.deepEqual(parsed.forwardArgs, [
    "--mode",
    "hybrid",
    "--route",
    "task",
    "--tool",
    "openclaw",
    "--source-kind",
    "blackboard",
    "--task-state",
    "FAILED",
    "--prefer-summaries",
  ]);
  assert.deepEqual(parsed.queryParts, ["shrimp queue"]);
});

test("parseCliArgs still supports legacy positional top-k", () => {
  const parsed = parseCliArgs(["portable memory", "7"]);
  assert.equal(parsed.topK, 7);
  assert.deepEqual(parsed.queryParts, ["portable memory"]);
});

test("parseCliArgs tracks --mmr flag", () => {
  const parsed = parseCliArgs(["--mmr", "--mmr-lambda", "0.5", "--top-k", "8", "test query"]);
  assert.equal(parsed.mmr, true);
  assert.equal(parsed.modeExplicit, false);
  assert.equal(parsed.mode, "bm25");
  assert.ok(parsed.forwardArgs.includes("--mmr"));
  assert.ok(parsed.forwardArgs.includes("--mmr-lambda"));
  assert.ok(parsed.forwardArgs.includes("0.5"));
});

test("buildPythonSearchArgs auto-upgrades --mmr to --mode hybrid when no explicit mode", () => {
  const parsed = parseCliArgs(["--mmr", "--top-k", "5", "memory retrieval"]);
  const args = buildPythonSearchArgs({ scriptPath: "search.py", parsed, query: "memory retrieval" });
  // Should prepend --mode hybrid before --mmr
  assert.ok(args.indexOf("--mode") < args.indexOf("--mmr"), "mode should appear before mmr");
  assert.ok(args.includes("hybrid"), "should contain hybrid mode");
  assert.ok(args.includes("--mmr"), "should still contain --mmr");
  assert.ok(args.includes("--top-k"), "should contain top-k");
  assert.ok(args.includes("5"), "should contain top-k value");
});

test("buildPythonSearchArgs preserves explicit --mode when --mmr is also set", () => {
  const parsed = parseCliArgs(["--mmr", "--mode", "dense", "--top-k", "3", "test"]);
  const args = buildPythonSearchArgs({ scriptPath: "search.py", parsed, query: "test" });
  // Explicit --mode dense should NOT be overridden to hybrid
  assert.ok(args.includes("--mode"), "should contain --mode");
  const modeIdx = args.indexOf("--mode");
  assert.equal(args[modeIdx + 1], "dense", "mode should be dense, not overridden");
  assert.ok(args.includes("--mmr"), "should still contain --mmr");
});

test("buildPythonSearchArgs keeps server mode queryless and search mode json-wrapped", () => {
  const searchParsed = parseCliArgs(["--mode", "dense", "--tool", "openclaw", "queue full"]);
  assert.deepEqual(buildPythonSearchArgs({
    scriptPath: "semantic-search.py",
    parsed: searchParsed,
    query: "queue full",
  }), ["semantic-search.py", "--mode", "dense", "--tool", "openclaw", "--json", "queue full"]);

  const serverParsed = parseCliArgs(["--server", "--mode", "hybrid"]);
  assert.deepEqual(buildPythonSearchArgs({
    scriptPath: "semantic-search.py",
    parsed: serverParsed,
    query: "",
  }), ["semantic-search.py", "--mode", "hybrid"]);
});
