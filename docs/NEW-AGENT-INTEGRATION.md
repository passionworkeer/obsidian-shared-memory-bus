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
1. Give the agent the canonical read order for shared memory
2. Point it to the durable writeback path
3. Wire shared MCP endpoints for `memory`, `obsidian`, and any safe utility services
4. Decide whether it should use shared `playwright` or stay local
5. Expose portable skills if the agent supports them
6. Add host-native plugins only if the agent truly needs lifecycle hooks or UI
7. Run a smoke test and write the result into validation notes

See `docs/INTEGRATION-MODES.md` for the recommended MCP versus skill versus plugin split.

## Canonical Shared Memory Read Order
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

## Shared MCP Core
Most new agents should start with:
- `memory`
- `obsidian`
- `context7`
- `fetch`
- `time`
- `sequential-thinking`

Add `playwright` only when the agent actually needs browser automation.

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

## Documentation To Update
When a new agent becomes supported, update:
- `README.md`
- `docs/VALIDATION.md`
- `docs/FILES.md`
- any agent-specific onboarding or config snippets
