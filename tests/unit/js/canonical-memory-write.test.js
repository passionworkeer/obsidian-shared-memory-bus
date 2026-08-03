import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { writeCanonicalMemory } = await import("../../../ops/mcp/canonical-memory-write.js");
const { validateStructuredRecord } = await import("../../../ops/memory/memory-contract.js");

describe("canonical MCP memory writes", () => {
  let tempRoot;
  let originalStore;
  let originalStoreRoot;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "canonical-memory-write-"));
    originalStore = process.env.AI_MEMORY_STORE;
    originalStoreRoot = process.env.AI_MEMORY_STORE_ROOT;
    process.env.AI_MEMORY_STORE = tempRoot;
    delete process.env.AI_MEMORY_STORE_ROOT;
  });

  afterEach(() => {
    if (originalStore == null) delete process.env.AI_MEMORY_STORE;
    else process.env.AI_MEMORY_STORE = originalStore;

    if (originalStoreRoot == null) delete process.env.AI_MEMORY_STORE_ROOT;
    else process.env.AI_MEMORY_STORE_ROOT = originalStoreRoot;

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test("writes a valid V2 record and a same-id compatibility projection", async () => {
    const result = await writeCanonicalMemory({
      agent_id: "codex",
      project: "demo-project",
      facts: [{
        content: "The canonical writer feeds the structured memory bus.",
        session_type: "feature",
        confidence: 0.95,
        decisions: ["Keep legacy project JSONL as a compatibility projection."],
      }],
    });

    assert.equal(result.ok, true);
    assert.equal(result.canonical, true);
    assert.equal(result.written.length, 1);

    const canonicalPath = path.join(tempRoot, "structured", "shared-inbox.jsonl");
    const compatibilityPath = path.join(tempRoot, "projects", "demo-project.jsonl");
    assert.equal(result.canonical_path, canonicalPath);
    assert.equal(result.compatibility_path, compatibilityPath);

    const canonical = JSON.parse(fs.readFileSync(canonicalPath, "utf8").trim());
    const compatibility = JSON.parse(fs.readFileSync(compatibilityPath, "utf8").trim());

    assert.equal(canonical.id, compatibility.id);
    assert.equal(canonical.id, result.written[0]);
    assert.equal(canonical.schemaVersion, 2);
    assert.equal(canonical.tool, "codex");
    assert.equal(canonical.source_kind, "writeback");
    assert.equal(canonical.memory_level, "durable");
    assert.equal(canonical.project, "demo-project");
    assert.match(canonical.content_hash, /^[a-f0-9]{64}$/);
    assert.equal(validateStructuredRecord(canonical).ok, true);
  });

  test("rejects invalid facts before writing either data plane", async () => {
    await assert.rejects(
      writeCanonicalMemory({
        project: "demo-project",
        facts: [{ content: "", confidence: 2 }],
      }),
      /content/
    );

    assert.equal(fs.existsSync(path.join(tempRoot, "structured", "shared-inbox.jsonl")), false);
    assert.equal(fs.existsSync(path.join(tempRoot, "projects", "demo-project.jsonl")), false);
  });
});
