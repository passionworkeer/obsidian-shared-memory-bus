# Quickstart

Get from zero to a working shared memory bus in 30 minutes. Five steps.

---

## Step 1 — Install (10 minutes)

### Windows

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File `
  .\scripts\install.ps1 `
  -WorkspaceRoot E:\desktop\your-project
```

`-WorkspaceRoot` is optional, but if you use it here it must point at an existing repo/workspace root.

The installer will:
1. Copy the runtime to `~/.ai-memory`
2. Detect your Python runtime (prefers `uv`-managed Python)
3. Install `rank-bm25` and `jieba` for BM25 search
4. Write environment variables `AI_MEMORY_ROOT` and `AI_MEMORY_PYTHON`
5. Start the watchdog and shared MCP stack

### macOS / Linux

```bash
./scripts/install.sh -WorkspaceRoot ~/projects/your-project
# Then activate in your shell:
source ~/.ai-memory/activate-ai-memory.sh
```

---

## Step 2 — Configure Embedding Provider (5 minutes)

By default, the system uses **offline `hashing-v1`** — no API key needed, works fully offline.

To upgrade to a remote embedding provider, set environment variables:

```powershell
# OpenAI-compatible (e.g. local Ollama, ModelScope, Groq)
[Environment]::SetEnvironmentVariable("AI_MEMORY_EMBED_PROVIDER", "openai-compatible-remote", "User")
[Environment]::SetEnvironmentVariable("AI_MEMORY_EMBED_ADAPTER", "openai-compatible", "User")
[Environment]::SetEnvironmentVariable("AI_MEMORY_EMBED_BASE_URL", "https://your-endpoint/v1", "User")
[Environment]::SetEnvironmentVariable("AI_MEMORY_EMBED_API_KEY", "your-key", "User")
[Environment]::SetEnvironmentVariable("AI_MEMORY_EMBED_MODEL", "your-model", "User")
[Environment]::SetEnvironmentVariable("AI_MEMORY_EMBED_PROFILE", "openai-compatible", "User")
```

After changing providers, **rebuild the embeddings index**:

```powershell
node $env:AI_MEMORY_ROOT\generate-embeddings.js
```

Check the active runtime:

```powershell
# Via MCP tool (after install):
claude -p "$(cat <<'EOF'
{"tools":[{"name":"list_embedding_runtimes"}]}
EOF
)"
```

Or check manually:
```powershell
cat ~/.ai-memory/config/runtime.json
```

---

## Step 3 — First Write and Read (5 minutes)

Verify the shared stack is running:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File $env:AI_MEMORY_ROOT\shared-mcp\status-shared-mcp.ps1
```

Expected output: all servers show `running: true` on ports 9331–9338.

**Write a memory record** (via MCP):

```powershell
claude -p "$(cat <<'EOF'
{"tools":[{"name":"memory_status"}]}
EOF
)"
```

Look for `embeddings.count` — this is how many records are indexed.

**Run your first search** (via MCP):

```powershell
claude -p "$(cat <<'EOF'
{"tools":[{"name":"search_shared_memory","input":{"query":"your recent project decisions","limit":3}}]}
EOF
)"
```

Expected: top 3 results from your `.ai-memory` store's `structured/` layer.

If results are empty:
1. Run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\memory-watchdog.ps1 -Once` to force a sync
2. Check that `AI_MEMORY_STORE` points to the correct store root (default `E:\.ai-memory\`)
3. See [`TROUBLESHOOTING.md`](../TROUBLESHOOTING.md) "My memory retrieval returns empty results"

---

## Step 4 — Multi-Agent Shared Memory (5 minutes)

After install, your Claude Code, Codex, OpenCode, Cursor, and Copilot all share the same memory layer automatically.

**Verify integration** for each tool:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File $env:AI_MEMORY_ROOT\verify-client-integrations.ps1 `
  -WorkspaceRoot E:\desktop\your-project `
  -RunCliChecks
```

Expected: `overallPass: true` for all clients.

`verify-client-integrations` is a self-healing validator. It may restart unhealthy shared MCP services and writes a report file. If you only want to inspect current state, prefer `status-shared-mcp.ps1 -Json`.

**Trigger a cross-agent sync**:
```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File $env:AI_MEMORY_ROOT\memory-watchdog.ps1 -Once
```

Now OpenClaw tasks, Codex sessions, and Claude Code memories are all visible to each other via `search_shared_memory`.

**Filter by agent source**:
```powershell
claude -p "$(cat <<'EOF'
{"tools":[{"name":"search_shared_memory","input":{"query":"task state decisions","route":"task","limit":5}}]}
EOF
)"
```

---

## Step 5 — Validate and Troubleshoot (5 minutes)

### Health Check

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File $env:AI_MEMORY_ROOT\shared-mcp\status-shared-mcp.ps1
```

| Status | Meaning |
|--------|---------|
| `watchdog.running: true` | Memory is refreshing automatically |
| `watchdog.running: false` | Watchdog stopped — run `start-shared-mcp.ps1` |
| `embeddings.count: 0` | Embeddings not built — run `generate-embeddings.js` |

### Pressure Test

Before trusting the stack for heavy multi-agent work:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File $env:AI_MEMORY_ROOT\run-pressure-test.ps1 `
  -WorkspaceRoot E:\desktop\your-project `
  -Waves 3 `
  -RunCliChecks
```

Look for `overallPass: true`, `singleListenerPerPort: true`, `allPidsStable: true`.

### Common Issues

| Symptom | Fix |
|---------|-----|
| `embeddings.count` stays 0 | Run `node $env:AI_MEMORY_ROOT\generate-embeddings.js` |
| `search_shared_memory` returns empty | Check `AI_MEMORY_STORE` path; force sync with `memory-watchdog.ps1 -Once` |
| Playwright MCP failed in `mcp list` | This is a false negative — verify with real browser tasks |
| `memory_status.watchdog.status: stale` | Restart watchdog: `start-shared-mcp.ps1` |
| All agents returning same old results | Run `node $env:AI_MEMORY_ROOT\generate-embeddings.js` then verify with `memory_status` |

Full troubleshooting guide: [`TROUBLESHOOTING.md`](../TROUBLESHOOTING.md)

---

## What Just Happened?

After these 5 steps you have:

```
✅ Shared MCP stack running on ports 9331–9338
✅ Watchdog auto-refreshing memory every 15s
✅ BM25 + dense hybrid retrieval over your local `.ai-memory` store
✅ Multi-agent memory sharing across Claude Code / Codex / OpenCode / Cursor / Copilot / Trae
✅ Generated artifacts (MEMORY-LAYERS, HANDOFF, AUTO-DREAM) auto-refreshing
```

Next steps:
- Read [`ARCHITECTURE.md`](../ARCHITECTURE.md) to understand the design
- Read [`DATA-FLOW.md`](DATA-FLOW.md) for the complete data lifecycle
- Read [`OPERATIONS.md`](../OPERATIONS.md) for day-to-day management commands
