/**
 * memory-generation.js
 *
 * Handles all memory-generation / derived-artifact tools:
 *   rebuild_memory_layers
 *   build_handoff_pack
 *   run_memory_dream
 *
 * Exposes a factory: createMemoryGeneration(params) => { tools, handlers }
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

function jsonResult(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

function spawnProcess(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      ...options,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code || 0, stdout, stderr });
    });

    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

function readOptionalJson(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return { ok: false, error: String(error), path: filePath };
  }
}

/**
 * @param {Object} params
 * @param {boolean} params.IS_WINDOWS
 * @param {string}  params.VAULT_ROOT
 * @param {string}  params.MEMORY_BUS_SCRIPT
 * @param {string}  params.MEMORY_LAYERS_JSON_PATH
 * @param {string}  params.HANDOFF_PACK_JSON_PATH
 * @param {string}  params.AUTO_DREAM_JSON_PATH
 * @param {Object}  params.RUNTIME_ENV
 * @param {string}  params.POWERSHELL_COMMAND
 */
export function createMemoryGeneration(params) {

  async function refreshDerivedArtifacts() {
    const { MEMORY_BUS_SCRIPT, VAULT_ROOT, RUNTIME_ENV, POWERSHELL_COMMAND, IS_WINDOWS } = params;

    if (!fs.existsSync(MEMORY_BUS_SCRIPT)) {
      throw new Error(`memory-bus-script-missing: ${MEMORY_BUS_SCRIPT}`);
    }

    const args = IS_WINDOWS
      ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", MEMORY_BUS_SCRIPT, "-Action", "RefreshDerivedArtifacts", "-Quiet"]
      : ["-NoProfile", "-File", MEMORY_BUS_SCRIPT, "-Action", "RefreshDerivedArtifacts", "-Quiet"];

    const result = await spawnProcess(POWERSHELL_COMMAND, args, {
      env: {
        ...RUNTIME_ENV,
        AI_MEMORY_OBSIDIAN_VAULT: VAULT_ROOT,
      },
    });

    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `refresh-derived-artifacts-exit-${result.code}`);
    }

    return {
      ok: true,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
      memoryLayers: readOptionalJson(params.MEMORY_LAYERS_JSON_PATH),
      handoffPack: readOptionalJson(params.HANDOFF_PACK_JSON_PATH),
      autoDream: readOptionalJson(params.AUTO_DREAM_JSON_PATH),
    };
  }

  async function handleRebuildMemoryLayers() {
    const result = await refreshDerivedArtifacts();
    return jsonResult({
      ok: true,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
      summary: result.memoryLayers,
    });
  }

  async function handleBuildHandoffPack() {
    const result = await refreshDerivedArtifacts();
    return jsonResult({
      ok: true,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
      summary: result.handoffPack,
    });
  }

  async function handleRunMemoryDream(args) {
    const result = await refreshDerivedArtifacts();
    return jsonResult({
      ok: true,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
      summary: result.autoDream,
      force: Boolean(args.force),
    });
  }

  return {
    tools: [
      {
        name: "rebuild_memory_layers",
        description:
          "Rebuild derived shared memory layers such as shared inbox records, session-layer records, and shared event records.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "build_handoff_pack",
        description:
          "Build a bounded handoff pack with current goal, done, next, blocked, files, open threads, and tool invariants.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "run_memory_dream",
        description:
          "Run one memory dream consolidation pass over durable, session, and task layers to refresh AUTO-DREAM summaries.",
        inputSchema: {
          type: "object",
          properties: {
            force: { type: "boolean", default: false, description: "Force a dream pass even when gates would normally skip." },
          },
        },
      },
    ],
    handlers: {
      rebuild_memory_layers: handleRebuildMemoryLayers,
      build_handoff_pack: handleBuildHandoffPack,
      run_memory_dream: handleRunMemoryDream,
    },
  };
}
