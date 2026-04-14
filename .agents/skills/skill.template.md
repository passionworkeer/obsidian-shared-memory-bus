---
name: {AGENT_NAME}-shared-memory
description: {DESCRIPTION}
agent: {AGENT_NAME}
version: 1.0.0
generated-from: SKILL.md
---

# {AGENT_DISPLAY} — Shared Memory Bus Integration

This file extends `SKILL.md` (repo root) with {AGENT_DISPLAY}-specific configuration.
Read `SKILL.md` first, then apply the specifics below.

## {AGENT_DISPLAY} Skill Metadata

```yaml
name: {AGENT_NAME}-shared-memory
agent: {AGENT_NAME}
{MCP_SERVERS}
```

---

## Store Path Resolution

**Resolution order:**
1. `AI_MEMORY_STORE` or `AI_MEMORY_STORE_ROOT` environment variable
2. `AI_MEMORY_ROOT/.ai-memory` (if AI_MEMORY_ROOT is set)
3. Auto-detect best available drive (Windows: D-Z scan, min 2GB free)
4. Platform default:
   - Windows: `E:\.ai-memory`
   - macOS: `~/Library/Application Support/.ai-memory`
   - Linux: `XDG_DATA_HOME/.ai-memory` or `~/.local/share/.ai-memory`
{VAULT_NOTES}

**If resolution fails:** Write `"VAULT_RESOLUTION_FAILED"` to first line of `inbox/{AGENT_NAME}.md` and exit with error.

---

## Startup Behavior

{STARTUP_BLOCK}

---

## MCP Configuration

```json
{MCP_CONFIG_JSON}
```

---

## Rule File Setup

{RULE_SETUP_BLOCK}

---

## Memory Write Targets

### Cross-Project Durable (Shared Inbox)
```
<store-root>/inbox/{AGENT_NAME}.md
```

### Project Facts (via Stop Hook)
```
<store-root>/projects/<project-name>.jsonl
```

**Preferred:** Stop Hook auto-extraction — no manual write needed.
**Manual fallback:** Write to `inbox/{AGENT_NAME}.md`.

---

## Token Budget

{TOKEN_BUDGET}

---

## Store Path Resolution Check

**Verification command:**
```bash
node -e "console.log(require('./bus/store-root.js').resolveStoreRoot())"
echo $AI_MEMORY_STORE
echo $AI_MEMORY_STORE_ROOT
```

{VAULT_CHECK_NOTES}
