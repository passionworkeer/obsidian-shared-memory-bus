"use strict"

const fs = require("node:fs")
const path = require("node:path")

// ---------------------------------------------------------------------------
// Vault root resolution (same pattern as build-memory-layers.js)
// ---------------------------------------------------------------------------
function loadVaultRootHelper() {
  const candidates = [
    path.join(__dirname, "vault-root.js"),
    path.join(__dirname, "..", "bus", "vault-root.js"),
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return require(c)
  }
  throw new Error("vault-root-helper missing")
}

function resolveVaultRoot() {
  try {
    const { resolveVaultRoot: fn } = loadVaultRootHelper()
    return fn()
  } catch {
    return process.env.AI_MEMORY_OBSIDIAN_VAULT || "E:\\desktop\\Obsidian Vault"
  }
}

// ---------------------------------------------------------------------------
// Core bootstrap builder
// ---------------------------------------------------------------------------
/**
 * @param {string} cwd  — project working directory (default: process.cwd())
 * @returns {{ project_key: string, vaultRoot: string, l0BootstrapPath: string }}
 */
function buildL0L1Bootstrap(cwd) {
  const vaultRoot = resolveVaultRoot()
  const project_key = cwd ? path.basename(cwd) : ""

  const L0_FIXED = path.join(vaultRoot, "00-System/ai-memory/L0-fixed.md")
  const GENERATED = path.join(vaultRoot, "00-System/ai-memory/generated")
  const L0_BOOTSTRAP = path.join(GENERATED, "L0-bootstrap.md")
  const BODY_MD = path.join(GENERATED, "GLOBAL-CONTEXT.body.md")

  // 1. Read L0-fixed.md
  const L0_content = fs.existsSync(L0_FIXED) ? fs.readFileSync(L0_FIXED, "utf-8") : ""

  // 2. Query KG for current project triples
  let l1_content = "（暂无 L1 事实）"
  if (project_key) {
    try {
      const { KnowledgeGraph } = require("./knowledge-graph.js")
      const kg = new KnowledgeGraph({ vaultRoot })
      const triples = typeof kg.queryEntity === "function"
        ? kg.queryEntity(project_key, { limit: 20 })
        : []
      if (triples && triples.length > 0) {
        l1_content = triples
          .slice(0, 20)
          .map(t => {
            const s = t.subject || t.entity_name || ""
            const p = t.predicate || t.relation || ""
            const o = t.object || t.target_name || ""
            return `- ${s} ${p} ${o}`.trim()
          })
          .join("\n")
      }
      if (typeof kg.close === "function") kg.close()
    } catch (e) {
      l1_content = `（KG 不可用: ${e.message}）`
    }
  }

  // 3. Generate L0-bootstrap.md
  const timestamp = new Date().toISOString()
  const bootstrap = [
    "# L0+L1 Bootstrap",
    "",
    `> 生成时间: ${timestamp}`,
    `> 当前项目: ${project_key}`,
    "",
    "## L0 固定上下文",
    "",
    L0_content || "（无 L0-fixed.md）",
    "",
    "## L1 当前项目相关事实",
    "",
    l1_content,
    "",
    "---",
    `共 ${(l1_content && l1_content.startsWith("（") ? 0 : (triples || []).length)} 条 KG 事实 · 通过 memory_boot(cwd) 加载`,
    ""
  ].join("\n")

  if (!fs.existsSync(GENERATED)) fs.mkdirSync(GENERATED, { recursive: true })
  fs.writeFileSync(L0_BOOTSTRAP, bootstrap, "utf-8")

  // 4. Note: @include L0-bootstrap.md is managed by build-memory-layers.js template
  // (do not append here to avoid being overwritten)

  return { project_key, vaultRoot, l0BootstrapPath: L0_BOOTSTRAP }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
if (require.main === module) {
  const cwd = process.argv[2] || process.cwd()
  try {
    const result = buildL0L1Bootstrap(cwd)
    console.log(JSON.stringify({ ok: true, ...result }))
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: e.message }))
    process.exit(1)
  }
}

module.exports = { buildL0L1Bootstrap }
