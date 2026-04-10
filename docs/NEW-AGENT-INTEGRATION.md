# New Agent Integration

Use this guide when onboarding a new agent or client into the shared memory bus.

## Minimum Requirements
The new agent should be able to do at least one of these:
- call shared MCP services over HTTP
- read and write local files
- follow an onboarding or bootstrap instruction file

## Integration Goals
Every new agent should be able to:
- read the shared Obsidian memory layer
- write durable memory back into the correct inbox or project note
- use shared MCP services when they are safe to centralize
- keep isolated tools isolated

## Decision Rule: Shared Or Isolated?
Use shared MCP when the service is:
- stateless
- safe to centralize
- naturally exposed over local HTTP

Use isolated MCP when the service is:
- strongly tied to desktop UI state
- likely to leak state across sessions
- unsafe to centralize without a stronger isolation story

## Baseline Onboarding Steps
1. Give the agent the canonical read order for shared memory (see below)
2. Optionally wire `memory_wake_up` on port 9338 as a compact structured bootstrap alternative to reading individual files
3. Point it to the durable writeback path
4. Wire shared MCP endpoints for `memory`, `obsidian`, and any safe utility services
5. Decide whether it should use shared `playwright` or stay local
6. Expose portable skills if the agent supports them
7. Add host-native plugins only if the agent truly needs lifecycle hooks or UI
8. Run a smoke test and write the result into validation notes

See `docs/INTEGRATION-MODES.md` for the recommended MCP versus skill versus plugin split.

## Best Default Bundle
For most new agents, the best packaged integration is:
- shared HTTP MCP snippets for the safe default server set
- one portable skill or rule file for behavior
- one thin plugin adapter only if the host app truly needs native hooks or UI

The generated onboarding packs under `generated/onboarding/<agent>/` are built around that split.

Typical pack contents:
- `generic/AGENTS.md`
- `generic/codex.shared-mcp.toml`
- `generic/cursor.shared-mcp.json`
- `generic/copilot.shared-mcp.json`
- `generic/obsidian-stdio.json`
- `generic/skills/shared-memory/SKILL.md`
- `generic/plugin/README.md`
- `generic/platforms.md`
- `bootstrap.md`

## Official Apply Flow
For supported local clients, the source of truth is now:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -WorkspaceRoot <your-project-root>
```

That install flow now:
- installs or upgrades the flat runtime in `~/.ai-memory`
- regenerates onboarding packs and startup files
- applies global client wiring plus workspace overlays through `install-client-integrations.ps1`

If the runtime is already installed and you only need to re-apply client wiring, use:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $env:AI_MEMORY_ROOT\install-client-integrations.ps1 -WorkspaceRoot <your-project-root>
```

`verify-integrations.ps1` remains only as a compatibility alias for the apply step. The real validation gate is `verify-client-integrations.ps1`.

## Canonical Shared Memory Read Order
For structured bootstrap, the preferred first option is `memory_wake_up` on port 9338 — it returns a compact pack covering durable anchors, next steps, blockers, and recent activity in a single call.

If the agent cannot call MCP tools, fall back to reading files in this order:
1. `02-KB/OBSIDIAN.md`
2. `02-KB/MEMORY.md`
3. `02-KB/WORKING.md`
4. `00-System/ai-memory/generated/GLOBAL-CONTEXT.md`

## Portable Placeholder Rules
When documenting or committing agent overlays, use portable placeholders instead of local absolute paths.

- use `<obsidian-vault>` for the vault root
- use `<repo-root>` for the checked-out repository root
- use home-relative examples such as `~/.trae/user_rules.md` when a user-scoped file matters

Do not publish tracked onboarding files with machine-specific paths like `C:\Users\...` or `E:\...`.

Typical tracked overlay files include:
- `AGENTS.md`
- `.github/copilot-instructions.md`
- `.trae/rules/project_rules.md`

Runtime scripts may resolve placeholders dynamically, but the committed template should stay portable.

## Durable Writeback Rules
- cross-project facts go to the tool inbox under `00-System/ai-memory/inbox/`
- active task state goes to `02-KB/WORKING.md`
- project-specific durable facts go to the relevant project note
- never write secrets into shared memory

## Verbatim Snippet Windows

When the agent calls `search_shared_memory`, it can opt into verbatim snippet extraction with:

- `includeVerbatim: true` — return query-aware exact text windows around each match
- `snippetWindow` (integer, default 220) — character window kept around each match
- `maxVerbatimPerResult` (integer, default 1) — maximum snippet windows per result

This is useful when the agent needs to show the user the exact source text rather than only a summary. It works across all retrieval modes (`bm25`, `dense`, `hybrid`, `auto`).

## Shared MCP Core
Most new agents should start with:
- `memory`
- `obsidian`
- `context7`
- `fetch`
- `time`
- `sequential-thinking`

Add `playwright` when the agent actually needs browser automation. The built-in apply flow wires it by default because it is usually the biggest per-agent process multiplier; opt out with `-SkipPlaywright` when a host should keep browser automation local.

In the built-in apply flow, the default wiring set is:
- every server whose manifest `mode` is `shared`
- `playwright` by default because it is usually the biggest source of duplicated per-agent MCP processes
- `MiniMax` only when explicitly included

## Three-Platform Recommendation
- Windows:
  - use the full control plane when possible
  - prefer shared HTTP MCP plus the portable skill/rule layer
- macOS:
  - prefer the shared HTTP MCP snippets plus the portable skill/rule layer
  - use a plugin only for host-native last-mile integration
- Linux:
  - prefer the shared HTTP MCP snippets plus the portable skill/rule layer
  - use a plugin only for host-native last-mile integration

## Skills Sharing
If the agent supports skills or prompt libraries:
- use the portable shared skills root where possible
- avoid duplicating skills that can be mirrored or linked
- document whether the agent reads native skills, portable skills, or both

## Validation Checklist
- can the agent read the shared memory bootstrap files?
- can it call `memory` successfully?
- can it call `obsidian` successfully?
- does it write back to the correct durable path?
- does enabling browser automation avoid spawning a new local Playwright server per task?
- does the generated or tracked overlay avoid writing workstation-specific absolute paths back into the repo?
- can the watchdog supervisor be started standalone (`bus/memory-watchdog-supervisor.ps1 -Daemon`) and recover the shared MCP stack after a crash?
- does periodic inbox hygiene run cleanly (`ops/cleanup-inbox.ps1`)?
- if runtime validation is enabled, does a failed client task mean the shared MCP stack is really down, or is it only a provider-auth skip such as missing API key / missing login?

## Documentation To Update
When a new agent becomes supported, update:
- `README.md`
- `docs/INSTALL.md`
- `docs/ARCHITECTURE.md`
- `docs/VALIDATION.md`
- any agent-specific onboarding or config snippets

## Maintenance

Schedule or run periodically:
- `ops/cleanup-inbox.ps1` — removes shared inbox entries older than 7 days
- `ops/build-memory-layers.js` — refreshes the MEMORY-LAYERS generated artifact
- `ops/build-handoff-pack.js` — refreshes the HANDOFF generated artifact
- `ops/run-memory-dream.ps1` — consolidates AUTO-DREAM summaries across durable, session, and task layers
