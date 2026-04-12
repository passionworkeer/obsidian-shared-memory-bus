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

## Vault Path Resolution

**Resolution order:**
1. `AI_MEMORY_OBSIDIAN_VAULT` environment variable
2. `OBSIDIAN_VAULT_ROOT` environment variable
3. Obsidian app config detection
4. Default fallback
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
<obsidian-vault>/00-System/ai-memory/inbox/{AGENT_NAME}.md
```

### Active Task State
```
<obsidian-vault>/02-KB/WORKING.md
```
Write within your `## Agent: {AGENT_NAME}` block.

---

## Token Budget

{TOKEN_BUDGET}

---

## Vault Path Resolution Check

**Verification command:**
```bash
echo $AI_MEMORY_OBSIDIAN_VAULT
echo $OBSIDIAN_VAULT_ROOT
```

{VAULT_CHECK_NOTES}
