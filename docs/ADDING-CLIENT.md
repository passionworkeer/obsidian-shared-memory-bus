# Adding Another AI Tool to the Shared Memory Bus

This guide shows how to connect a second (or third...) AI coding tool to the shared memory bus.

## What "Client" Means Here

A "client" is an AI tool running on the same machine that you want to share memory with. Examples:
- Claude Code (already supported)
- OpenCode (already supported)
- Cursor (already supported)
- VS Code + GitHub Copilot (already supported)
- Trae (already supported)
- A new AI tool you've never used before

All of these can share the same memory once connected.

## Step-by-Step: Connect Another Tool

### Step 1: Verify the Shared Bus is Running

```powershell
ai-memory mcp:status
```

You should see "running" for most services. If not, start them:

```powershell
ai-memory mcp:start
```

### Step 2: Apply Client Configuration

The installer can automatically configure most supported clients:

```powershell
# On Windows
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\install-client-integrations.ps1 -WorkspaceRoot <your-project-root>

# On macOS/Linux
~/.ai-memory/install-client-integrations.sh -WorkspaceRoot <your-project-root>
```

This updates:
- `~/.cursor/mcp.json` — adds shared MCP endpoints
- `~/.vscode/mcp.json` — adds shared MCP endpoints (VS Code/Copilot)
- `opencode.json` — updates OpenCode config
- Workspace overlays in your project directory

### Step 3: Restart the Client

After applying new client configurations, restart the AI tool or reload its window for the new MCP endpoints to take effect.

### Step 4: Verify It Works

In the newly connected tool, try:

```
# Ask the tool to read shared memory
Read the shared memory context from 02-KB/OBSIDIAN.md and 02-KB/MEMORY.md

# Ask the tool to search shared memory
Search shared memory for "my project setup"

# Ask the tool to write to shared memory
Remember that my project uses React + TypeScript
```

The tool should be able to read and write to the shared Obsidian vault.

## After Registration

Once the client is wired to the shared bus, the following tools and scripts are available:

**Compact memory bootstrap**: Use the `memory_wake_up` MCP tool on port 9338 to get a structured session bootstrap pack covering durable anchors, handoff data, and recent activity. This is faster than reading individual bootstrap files for every new session.

**Verbatim snippet search**: `search_shared_memory` supports `includeVerbatim: true` to return query-aware exact text windows around each match, with `snippetWindow` (default 220 chars) and `maxVerbatimPerResult` (default 1) for fine-tuning.

**Inbox hygiene**: Run the cleanup script periodically to remove shared inbox entries older than 7 days:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\ops\cleanup-inbox.ps1
```

## Manual Configuration

If the auto-apply doesn't work for your tool, add these MCP endpoints manually:

### HTTP MCP Endpoints (all tools support these)

| Service | Endpoint | What it does |
|---------|----------|--------------|
| memory | http://127.0.0.1:9338/mcp | Shared memory search and retrieval |
| obsidian | http://127.0.0.1:9335/mcp | Read/write Obsidian notes |
| context7 | http://127.0.0.1:9331/mcp | Code search |
| fetch | http://127.0.0.1:9332/mcp | Web fetch |
| time | http://127.0.0.1:9333/mcp | Current time |
| sequential-thinking | http://127.0.0.1:9334/mcp | Reasoning helper |
| playwright | http://127.0.0.1:9337/mcp | Browser automation (optional) |

### Example: Manual MCP Config

In your tool's MCP settings, add:

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-http", "http://127.0.0.1:9338/mcp"]
    },
    "obsidian": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-http", "http://127.0.0.1:9335/mcp"]
    }
  }
}
```

## Troubleshooting

**The new client can't find shared memory?**

1. Run `ai-memory doctor` to check setup
2. Check `ai-memory mcp:status` — ensure memory MCP shows "running"
3. Check the client's MCP config points to `http://127.0.0.1:9338` (not `localhost` which may resolve differently)

**Error: "connection refused"**

The shared MCP isn't running. Run `ai-memory mcp:start` first.

**Old client still using its own memory?**

After connecting to shared memory, old sessions may still use local memory. Start a new session to use shared memory.

## Supported Clients

| Client | Auto-configured? | Manual config needed? |
|--------|-----------------|----------------------|
| Claude Code | Yes | No |
| OpenCode | Yes | No |
| Cursor | Yes | No |
| VS Code + Copilot | Yes | No |
| Trae | Yes | No |
| Other MCP-capable tools | No | Yes — use HTTP endpoints above |
