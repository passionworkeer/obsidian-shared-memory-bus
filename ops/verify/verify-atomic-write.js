/**
 * ops/verify-atomic-write.js
 * Verify the inbox atomic write fix with 10 concurrent child processes.
 *
 * Writes a temp JS file and spawns children using that file path so that
 * backslashes in string literals are not subject to shell/eval escaping.
 */
"use strict";

const path   = require("path");
const fs     = require("fs");
const os     = require("os");
const { spawn } = require("node:child_process");

const PROJECT_ROOT = path.resolve(__dirname, "..");

// Resolve the Obsidian vault from the Obsidian app config.
function resolveObsidianVaultRoot() {
  try {
    const obsidianCfg = path.join(process.env.APPDATA || "", "obsidian", "obsidian.json");
    const { vaults } = JSON.parse(fs.readFileSync(obsidianCfg, "utf8"));
    const active = Object.values(vaults).find(v => v.open) || Object.values(vaults)[0];
    return active ? active.path : null;
  } catch (_e) {
    return null;
  }
}

const vault     = resolveObsidianVaultRoot() ||
  process.env.AI_MEMORY_OBSIDIAN_VAULT ||
  process.env.OBSIDIAN_VAULT_ROOT ||
  "E:\\desktop\\Obsidian Vault";

const inboxPath = path.join(vault, "00-System", "ai-memory", "inbox", "stress-verify.md");
const inboxDir  = path.dirname(inboxPath);
const session   = "verify-" + Date.now();
const N         = 10;

// ---------------------------------------------------------------------------
// Build a child-entry script to disk so no shell-escaping issues arise.
// ---------------------------------------------------------------------------

const childScriptPath = path.join(os.tmpdir(), `atomic-write-child-${process.pid}.js`);

// Use JSON.stringify to safely embed the strings without any escaping risk.
const childScriptContent = [
  "/* Auto-generated child entry — do not edit */",
  "'use strict';",
  "const path = require('path');",
  "const { appendLineAtomic } = require(" + JSON.stringify(path.join(PROJECT_ROOT, "ops", "inbox-atomic-write.js")) + ");",
  "const inboxPath = " + JSON.stringify(inboxPath) + ";",
  "const id = Number(process.argv[2] || '0');",
  "const session = " + JSON.stringify(session) + ";",
  "const line = '\\n- [2026-04-11T10:00:00.000Z] [verify] id=' + id + ' session=' + session;",
  "try {",
  "  appendLineAtomic(inboxPath, line, { createDir: true });",
  "  process.stdout.write('ok');",
  "} catch(e) {",
  "  process.stderr.write(e.message);",
  "  process.exit(1);",
  "}",
].join("\n");

fs.writeFileSync(childScriptPath, childScriptContent, "utf8");

// ---------------------------------------------------------------------------
// Pre-create inbox directory (children also handle this, but be safe)
// ---------------------------------------------------------------------------

if (!fs.existsSync(inboxDir)) fs.mkdirSync(inboxDir, { recursive: true });
if (fs.existsSync(inboxPath)) fs.unlinkSync(inboxPath);

// ---------------------------------------------------------------------------
// Spawn N children
// ---------------------------------------------------------------------------

const promises = Array.from({ length: N }, (_, id) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [childScriptPath, String(id)], { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", d => { stderr += d; });
    child.on("close", code => resolve({ id, code, stderr }));
  })
);

Promise.all(promises)
  .then(results => {
    // Clean up temp script
    try { fs.unlinkSync(childScriptPath); } catch (_e) { /* ignore */ }

    const allOk = results.every(r => r.code === 0 && r.stderr === "");
    const errors = results.filter(r => r.code !== 0);
    if (errors.length > 0) {
      console.error("Children with errors:");
      errors.forEach(r => console.error(" ", r.id, ":", r.code, r.stderr));
    }

    if (!fs.existsSync(inboxPath)) {
      console.log("File not found — children may have failed.");
      console.log("RESULT: FAIL");
      process.exit(1);
    }

    const content = fs.readFileSync(inboxPath, "utf8");
    const lines  = content.split(/\r?\n/).filter(l => l.includes(session));
    console.log("All child processes exited OK:", allOk);
    console.log("Written lines:", lines.length, "/", N);

    if (lines.length !== N) {
      console.log("Content (first 500 chars):\n" + content.slice(0, 500));
    }

    try { fs.unlinkSync(inboxPath); } catch (_e) { /* ignore */ }

    if (allOk && lines.length === N) {
      console.log("RESULT: PASS — no lines dropped under concurrent load");
      process.exit(0);
    } else {
      console.log("RESULT: FAIL");
      process.exit(1);
    }
  })
  .catch(err => {
    console.error("Unexpected error:", err);
    process.exit(1);
  });
