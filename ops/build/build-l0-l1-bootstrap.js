"use strict"

const fs = require("node:fs")
const path = require("node:path")

// ---------------------------------------------------------------------------
// Store root resolution — no Obsidian dependency
// ---------------------------------------------------------------------------
function loadStoreRootHelper() {
  const candidates = [
    // bus/ sibling (project layout: ops/ and bus/ are siblings under project root)
    path.join(__dirname, "..", "..", "bus", "store-root.js"),
    // ops/bus/ (legacy nested layout)
    path.join(__dirname, "..", "bus", "store-root.js"),
    // Script-local (installed flat layout: ~/.ai-memory/ops/)
    path.join(__dirname, "store-root.js"),
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return require(c)
  }
  return null
}

function resolveStoreRoot() {
  const helper = loadStoreRootHelper()
  if (helper) {
    try { return helper.resolveStoreRoot() } catch { /* fall through */ }
  }
  // Use DEFAULT_STORE_ROOT from store-root.js to avoid hardcoding
  const { DEFAULT_STORE_ROOT } = require("./store-root.js")
  return process.env.AI_MEMORY_STORE || DEFAULT_STORE_ROOT
}

// ---------------------------------------------------------------------------
// Core bootstrap builder
// ---------------------------------------------------------------------------
/**
 * @param {string} cwd  — project working directory (default: process.cwd())
 * @returns {{ project_key: string, storeRoot: string, l0BootstrapPath: string }}
 */
function buildL0L1Bootstrap(cwd) {
  const storeRoot = resolveStoreRoot()
  const project_key = cwd ? path.basename(cwd) : ""

  const L0_FIXED = path.join(storeRoot, "L0-fixed.md")
  const GENERATED = path.join(storeRoot, "generated")
  const L0_BOOTSTRAP = path.join(GENERATED, "L0-bootstrap.md")
  const BODY_MD = path.join(GENERATED, "GLOBAL-CONTEXT.body.md")

  // 1. Read L0-fixed.md
  const L0_content = fs.existsSync(L0_FIXED) ? fs.readFileSync(L0_FIXED, "utf-8") : ""

  // 2. Query KG for all current project facts via queryCurrentTriples
  let l1_content = "（暂无 L1 事实）"
  let l1Count = 0
  if (project_key) {
    try {
      const { KnowledgeGraph } = require("./knowledge-graph.js")
      const kg = new KnowledgeGraph({ storeRoot })
      const triples = typeof kg.queryCurrentTriples === "function"
        ? kg.queryCurrentTriples({ limit: 20 })
        : []
      l1Count = triples.length
      if (triples && triples.length > 0) {
        l1_content = triples
          .slice(0, 20)
          .map(t => {
            const s = t.subject || ""
            const p = t.predicate || ""
            const o = t.object || ""
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
    `共 ${l1Count} 条 KG 事实 · 通过 memory_boot(cwd) 加载`,
    ""
  ].join("\n")

  if (!fs.existsSync(GENERATED)) fs.mkdirSync(GENERATED, { recursive: true })
  fs.writeFileSync(L0_BOOTSTRAP, bootstrap, "utf-8")

  // 4. Note: @include L0-bootstrap.md is managed by build-memory-layers.js template
  // (do not append here to avoid being overwritten)

  return { project_key, storeRoot, l0BootstrapPath: L0_BOOTSTRAP, l1Count }
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
