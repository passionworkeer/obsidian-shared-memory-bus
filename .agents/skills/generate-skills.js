#!/usr/bin/env node
/**
 * generate-skills.js
 *
 * Reads .agents/skills/skill.template.md, substitutes placeholders for each
 * defined agent, and writes the result to .agents/skills/{agent}.md.
 *
 * Usage: node generate-skills.js
 *        node generate-skills.js --dry-run   (print to stdout instead of writing)
 */

"use strict";

const fs   = require("fs");
const path = require("path");

// ── Resolve <repo-root> relative to this script ─────────────────────────────────
const SCRIPT_DIR    = __dirname;                              // .agents/skills/
const REPO_ROOT    = path.resolve(SCRIPT_DIR, "..", "..");  // repo root
const TEMPLATE_PATH = path.join(SCRIPT_DIR, "skill.template.md");
const OUT_DIR       = SCRIPT_DIR;

// ── Shared MCP server port map ─────────────────────────────────────────────────
const MCP_SERVERS_STANDARD = [
    ["memory",              "9338"],
    ["obsidian",            "9335"],
    ["context7",            "9331"],
    ["fetch",               "9332"],
    ["time",                "9333"],
    ["sequential-thinking",  "9334"],
];

const MCP_SERVERS_COPILOT = [
    ["memory",   "9338"],
    ["obsidian", "9335"],
    ["context7", "9331"],
    ["fetch",    "9332"],
    ["time",     "9333"],
    // sequential-thinking intentionally omitted (not in Copilot's yaml metadata)
];

// ── MCP YAML block ─────────────────────────────────────────────────────────────
function mcpYaml(servers) {
    return servers.map(([name, port]) => `mcp_server: ${name} (port ${port})`).join("\n");
}

// ── MCP JSON config block (full MCP servers block for the ## MCP Configuration section) ──
function mcpJsonSection(servers) {
    const entries = {};
    for (const [name, port] of servers) {
        entries[name] = { transport: "http", url: `http://127.0.0.1:${port}/mcp` };
    }
    return JSON.stringify({ mcpServers: entries }, null, 2);
}

// ── Claude Code settings.json MCP stub (shown in Rule File Setup) ───────────────
const CLAUDE_SETTINGS_JSON = JSON.stringify({
    mcpServers: {
        memory:              { transport: "http", url: "http://127.0.0.1:9338/mcp" },
        obsidian:            { transport: "http", url: "http://127.0.0.1:9335/mcp" },
        context7:            { transport: "http", url: "http://127.0.0.1:9331/mcp" },
        fetch:               { transport: "http", url: "http://127.0.0.1:9332/mcp" },
        time:                { transport: "http", url: "http://127.0.0.1:9333/mcp" },
        "sequential-thinking": { transport: "http", url: "http://127.0.0.1:9334/mcp" },
    },
}, null, 2);

// ── Copilot copilot-instructions.md inline ─────────────────────────────────────
const COPILOT_INSTRUCTIONS = `Add to \`.github/copilot-instructions.md\` (or equivalent):

\`\`\`markdown
## Shared Memory Bus

This project uses the Obsidian shared memory bus. See <repo-root>/SKILL.md for integration details.

Vault root: (set manually or leave blank if AI_MEMORY_OBSIDIAN_VAULT is configured in the shell environment)

Memory inbox: <vault-root>/00-System/ai-memory/inbox/copilot.md
\`\`\``;

// ── Per-agent configuration ────────────────────────────────────────────────────
// NOTE: Rule-setup blocks use {{}} to represent a literal "{" in the template
//       because the template engine uses ${...} for placeholders.
const agents = [
    {
        agentName:      "claude-code",
        agentDisplay:   "Claude Code",
        mcpServers:     MCP_SERVERS_STANDARD,
        description:    "Claude Code optimized integration for the Obsidian shared memory bus",

        vaultNotes: "",

        startupBlock: `Claude Code's \`sessionMemoryCompact\` hook fires at session end. Map it to write a session summary:

\`\`\`
Output path: <obsidian-vault>/sessions/YYYY-MM-DD/claude-code.md
Format: - [HH:mm:ss] session summary content
\`\`\`

This feeds into \`ops/sync-claudemem-to-obsidian.ps1\` → \`structured/claude-code.jsonl\`.`,

        mcpConfigJson: mcpJsonSection(MCP_SERVERS_STANDARD),

        ruleSetupBlock: "Add to `~/.claude/settings.json` (or equivalent):\n\n" +
                        "```json\n" + CLAUDE_SETTINGS_JSON + "\n```\n\n" +
                        "Place portable skill reference in your session start:\n\n" +
                        "```\nSkill: shared-memory-portable  (from templates/agents/portable-skill/SKILL.md)\nRule: .claude/rules/shared-memory.md\n```",

        tokenBudget: `- **Default session**: Read full canonical order (~8000 chars \`GLOBAL-CONTEXT.md\`)\n` +
                     `- **Quick session** (< 30 min): Use \`memory_wake_up max_items=5\` instead of full read\n` +
                     `- **Heavy session** (multi-hour): Full chain — \`GLOBAL-CONTEXT.md\` + \`AUTO-DREAM.md\` + \`HANDOFF.md\``,

        vaultCheckNotes: `If both are empty and Obsidian config is not found, this agent cannot auto-resolve. ` +
                         `In that case: write \`"VAULT_RESOLUTION_FAILED"\` to first line of \`inbox/claude-code.md\`.`,
    },

    {
        agentName:      "codex",
        agentDisplay:   "Codex",
        mcpServers:     MCP_SERVERS_STANDARD,
        description:    "Codex optimized integration for the Obsidian shared memory bus",

        vaultNotes: "\nCodex does not have a native session compaction hook. All memory flows through MCP.",

        startupBlock: `Codex does not have a native session memory compaction system.
At session start, call \`memory_wake_up\` for fast context bootstrap:

\`\`\`
Tool: memory_wake_up
max_items: 3
prefer_summaries: true   (keeps token usage under 3000)
\`\`\`

This avoids Codex reading the full \`GLOBAL-CONTEXT.md\` (~8000 chars) on every start.`,

        mcpConfigJson: mcpJsonSection(MCP_SERVERS_STANDARD),

        ruleSetupBlock: "Place the portable skill reference in Codex's skill directory:\n\n" +
                        "```\n~/.codex/skills/shared-memory.md  →  reference to SKILL.md at repo root\n~/.codex/rules/shared-memory.md   →  rule overlay\n```",

        tokenBudget: `- **Default session**: \`memory_wake_up preferSummaries=true\` (~3000 tokens max)\n` +
                     `- **Deep investigation**: Full canonical order + \`GLOBAL-CONTEXT.md\`\n` +
                     `- Codex sessions are typically shorter — avoid full \`GLOBAL-CONTEXT.md\` on quick queries\n\n` +
                     `**Rule: Do not let memory retrieval exceed 10% of your available context budget.**`,

        vaultCheckNotes: `If both are empty and Obsidian config is not found, write \`"VAULT_RESOLUTION_FAILED"\` to first line of \`inbox/codex.md\`.`,
    },

    {
        agentName:      "trae",
        agentDisplay:   "Trae",
        mcpServers:     MCP_SERVERS_STANDARD,
        description:    "Trae optimized integration for the Obsidian shared memory bus",

        vaultNotes: "\nTrae writes user rules to `~/.trae/user_rules.md` and project rules to `<project>/.trae/rules/project_rules.md`.",

        startupBlock: `Trae does not have a native session memory compaction system.
At workspace open, call \`memory_wake_up\` for compact bootstrap:

\`\`\`
Tool: memory_wake_up
max_items: 3   (compact — Trae sessions are typically IDE-bound and short)
\`\`\``,

        mcpConfigJson: mcpJsonSection(MCP_SERVERS_STANDARD),

        ruleSetupBlock: "Add to Trae's user rules or project rules:\n\n" +
                        "```\nReference: <repo-root>/SKILL.md\n```\n\n" +
                        "For project-level rules, create `<project>/.trae/rules/project_rules.md` with a pointer to `SKILL.md`.",

        tokenBudget: `- **IDE-bound session**: \`memory_wake_up max_items=3\` (compact bootstrap)\n` +
                     `- **Long investigation**: \`memory_wake_up max_items=5\` + \`GLOBAL-CONTEXT.md\`\n\n` +
                     `**Rule: Trae sessions are typically short and file-focused. Keep memory retrieval under 5% of context budget.**`,

        vaultCheckNotes: `If both are empty and Obsidian config is not found, write \`"VAULT_RESOLUTION_FAILED"\` to first line of \`inbox/trae.md\`.`,
    },

    {
        agentName:      "openclaw",
        agentDisplay:   "OpenClaw",
        mcpServers:     MCP_SERVERS_STANDARD,
        description:    "OpenClaw optimized integration for the Obsidian shared memory bus",

        vaultNotes: "",

        startupBlock: `At session start:
1. Read \`memory_wake_up max_items=5\` for cross-agent context
2. For cron job handoffs: also read \`AUTO-DREAM.md\` for durable promotion queue
3. OpenClaw's native task layer (\`blackboard\`) remains the primary task memory source`,

        mcpConfigJson: mcpJsonSection(MCP_SERVERS_STANDARD),

        ruleSetupBlock: "",

        tokenBudget: `- **Quick session**: \`memory_wake_up max_items=5\`\n` +
                     `- **Cron job handoff**: Full chain — \`GLOBAL-CONTEXT.md\` + \`AUTO-DREAM.md\` + \`HANDOFF.md\`\n` +
                     `- OpenClaw sessions can be very long; use full context for cross-agent handoffs`,

        vaultCheckNotes: `If both are empty and Obsidian config is not found, write \`"VAULT_RESOLUTION_FAILED"\` to first line of \`inbox/openclaw.md\`.`,
    },

    {
        agentName:      "cursor",
        agentDisplay:   "Cursor",
        mcpServers:     MCP_SERVERS_STANDARD,
        description:    "Cursor optimized integration for the Obsidian shared memory bus",

        vaultNotes: "\nCursor uses `.cursor/rules/` for project-specific rules.",

        startupBlock: `Cursor does not have a native session compaction system.
At workspace open, read \`GLOBAL-CONTEXT.md\` or call \`memory_wake_up\`:

\`\`\`
Tool: memory_wake_up
max_items: 5
route: project   (prioritize project-relevant memories)
\`\`\`

Use \`route=project\` to surface memories relevant to the current workspace.`,

        mcpConfigJson: mcpJsonSection(MCP_SERVERS_STANDARD),

        ruleSetupBlock: "For project-level rules, add to `.cursor/rules/`:\n\n" +
                        "```\nshared-memory.md  →  reference to <repo-root>/SKILL.md\n```",

        tokenBudget: `- **File-focused session**: \`memory_wake_up max_items=3\` (project context only)\n` +
                     `- **Deep session**: \`memory_wake_up max_items=5\` + \`GLOBAL-CONTEXT.md\`\n\n` +
                     `Cursor sessions are often file-focused. Use \`route=project\` to limit recall to relevant memories and avoid token waste.`,

        vaultCheckNotes: `If both are empty and Obsidian config is not found, write \`"VAULT_RESOLUTION_FAILED"\` to first line of \`inbox/cursor.md\`.`,
    },

    {
        agentName:      "copilot",
        agentDisplay:   "GitHub Copilot",
        mcpServers:     MCP_SERVERS_COPILOT,
        description:    "GitHub Copilot optimized integration for the Obsidian shared memory bus",

        vaultNotes: "\n**Important limitation**: GitHub Copilot operates per-file or per-commit with no native session memory system. Memory integration relies entirely on MCP calls and direct file writes. There is no environment variable injection capability in Copilot sessions.\n\n" +
                    "**Vault Resolution (Fallback Strategy)**\n\n" +
                    "Copilot cannot inject environment variables. Use a two-step fallback:\n\n" +
                    "### Step 1: Try MCP discovery\n" +
                    "Call the `obsidian` MCP tool to discover the vault root:\n" +
                    "```\nTool: list_directory\npath: /\n```\n" +
                    "Look for `00-System/ai-memory/` to identify the vault root from MCP results.\n\n" +
                    "### Step 2: If MCP discovery fails\n" +
                    "The vault root must be provided by the user or detected from the repo structure.\n" +
                    "Copilot typically runs in a project context — check if the repo is inside the Obsidian vault:\n" +
                    "```\nIs <repo-root> a subdirectory of <default-vault-path>?\nIf yes: use that vault root.\nIf no: use the configured vault root from the repo's .github/copilot-instructions.md.\n```",

        startupBlock: `Copilot has no session memory. At the start of each significant coding session:

\`\`\`
Tool: search_shared_memory
max_results: 3
route: reference   (prioritize external links, paths, docs)
\`\`\`

For cross-project context:
\`\`\`
Tool: memory_wake_up
max_items: 3
prefer_summaries: true
\`\`\``,

        mcpConfigJson: mcpJsonSection(MCP_SERVERS_COPILOT),

        ruleSetupBlock: COPILOT_INSTRUCTIONS,

        tokenBudget: `Copilot has the most constrained token budget. Follow these rules strictly:\n\n` +
                     `- **Per-file editing**: Do NOT call \`memory_wake_up\` on every keystroke. Call only at session start or when switching to a new significant task.\n` +
                     `- **Retrieval limit**: \`search_shared_memory max_results=3\` maximum per call\n` +
                     `- **Preferred route**: \`route=reference\` (finds paths, links, docs — most actionable for Copilot)\n` +
                     `- **Budget cap**: Memory calls must not exceed 5% of available context\n\n` +
                     `**Rule: If in doubt, skip memory retrieval rather than risk context overflow.**`,

        vaultCheckNotes: `Copilot cannot run shell commands or check environment variables directly. ` +
                         `Manual configuration required: set the vault root in \`.github/copilot-instructions.md\`. ` +
                         `If no vault is configured: write \`"VAULT_RESOLUTION_FAILED"\` to first line of \`inbox/copilot.md\`.`,
    },
];

// ── Template substitution ──────────────────────────────────────────────────────
function generate(template, agent) {
    return template
        .replace(/\{AGENT_NAME\}/g,        agent.agentName)
        .replace(/\{AGENT_DISPLAY\}/g,      agent.agentDisplay)
        .replace(/\{DESCRIPTION\}/g,       agent.description)
        .replace(/\{MCP_SERVERS\}/g,        mcpYaml(agent.mcpServers))
        .replace(/\{VAULT_NOTES\}/g,        agent.vaultNotes)
        .replace(/\{STARTUP_BLOCK\}/g,      agent.startupBlock)
        .replace(/\{MCP_CONFIG_JSON\}/g,    agent.mcpConfigJson)
        .replace(/\{RULE_SETUP_BLOCK\}/g,  agent.ruleSetupBlock)
        .replace(/\{TOKEN_BUDGET\}/g,       agent.tokenBudget)
        .replace(/\{VAULT_CHECK_NOTES\}/g, agent.vaultCheckNotes);
}

// ── Main ─────────────────────────────────────────────────────────────────────
const dryRun = process.argv.includes("--dry-run");

if (!fs.existsSync(TEMPLATE_PATH)) {
    console.error("ERROR: template not found at " + TEMPLATE_PATH);
    process.exit(1);
}

const template = fs.readFileSync(TEMPLATE_PATH, "utf8");

for (const agent of agents) {
    const content = generate(template, agent);
    const outPath = path.join(OUT_DIR, agent.agentName + ".md");

    if (dryRun) {
        console.log("\n========== [DRY RUN] " + agent.agentName + ".md ==========\n");
        console.log(content);
    } else {
        fs.writeFileSync(outPath, content, "utf8");
        console.log("Written: " + outPath);
    }
}

console.log("\nDone. " + agents.length + " skill files processed." + (dryRun ? " (dry run)" : ""));
