import test from "node:test";
import assert from "node:assert/strict";
import { buildPythonSearchArgs, parseCliArgs } from "./semantic-search-cli.js";

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
