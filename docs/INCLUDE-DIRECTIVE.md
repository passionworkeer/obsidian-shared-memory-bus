# @include Directive — Cross-Context Note Inclusion

## What @include Does

The `@include` directive lets you append a section of any note to the generated `GLOBAL-CONTEXT.md` body during session bootstrap. Instead of having the full note read every time, you explicitly mark the section to include. The memory bus appends that section's content to `GLOBAL-CONTEXT.md` so every agent starts with it in context.

## Syntax

```markdown
<!-- @include: <note-path> -->

## My Include Section

This content will be appended to GLOBAL-CONTEXT.md
```

The `<!-- @include: <note-path> -->` comment must appear **before** the section heading you want to include.

## How It Works

1. During session start, `build-memory-layers.js` scans for `@include` directives
2. It reads the referenced note
3. It extracts the content following the directive (from the next heading to the next same-level heading or end of file)
4. It appends that extracted content to `GLOBAL-CONTEXT.md`

## Which Agents/Tools Support It

| Agent | Support | Notes |
|-------|---------|-------|
| Claude Code | Yes | Via memory-bus.ps1 pipeline |
| Codex | Yes | Via shared MCP memory pipeline |
| OpenClaw | Yes | Via blackboard daemon |
| Cursor | Partial | Requires MCP integration |
| Copilot | No | Not yet integrated |
| Trae | No | Not yet integrated |

If an agent does not support `@include`, it simply ignores the directive. The note is still readable normally — the directive is purely additive for the memory bus bootstrap.

## Creating Include-able Sections

Design include-able sections with these guidelines:

1. **One concept per section** — each `@include` block should cover one topic
2. **Self-contained** — the section should make sense without reading the rest of the note
3. **Titled clearly** — use descriptive headings that indicate what the section covers
4. **Dated** — include a date in the heading for freshness signals

### Example

**Source note: `02-KB/PROJECT-STATE.md`**

```markdown
# Project State

## Overview

This project implements a shared memory bus for AI agents.

<!-- @include: 02-KB/PROJECT-STATE.md -->

## Current Sprint

- Implement entity extraction
- Add KG query support
- Improve retrieval recall

<!-- @include: 02-KB/PROJECT-STATE.md -->

## API Contract

The memory bus exposes:
- `memory_wake_up` for session bootstrap
- `search_shared_memory` for retrieval
- `memory_status` for health checks

<!-- @include: 02-KB/PROJECT-STATE.md -->

## Known Issues

- Windows popup windows may flash briefly
- Chinese entity extraction needs refinement
- Embeddings rebuild is slow on large vaults
```

When `GLOBAL-CONTEXT.md` is generated, it will include the "Current Sprint", "API Contract", and "Known Issues" sections appended to its body, but NOT the "Overview" section.

## Fallback Behavior

| Scenario | Behavior |
|----------|----------|
| Directive not supported | Directive comment ignored; rest of note read normally |
| Referenced note missing | Logged as warning; session continues without that section |
| Section heading not found | Nothing appended; no error |
| Note path is relative | Resolved relative to vault root |
| Note path absolute | Resolved as absolute path |

## Use Cases

### 1. Per-project state summaries

Keep project state in a dedicated note, include only the relevant section in bootstrap context:

```markdown
<!-- @include: 02-KB/my-project/STATE.md -->

## Active Tasks

- ...
```

### 2. API contract documentation

Include the current API contract summary so all agents share the same interface understanding:

```markdown
<!-- @include: 02-KB/API-CONTRACT.md -->

## Current Endpoints

- ...
```

### 3. Shared team conventions

Include coding conventions or team rules that all agents should follow:

```markdown
<!-- @include: 02-KB/CONVENTIONS.md -->

## Naming Conventions

- ...
```

## Limitations

- Only one level of heading is included (from the directive to the next same-level heading or end of file). Nested subsections within the included block ARE included.
- There is no loop detection. If note A includes note B and note B includes note A, the system will include both (producing duplicate content) without error.
- The `@include` directive is processed during `build-memory-layers.js` execution, which runs as part of the sync pipeline (triggered by watchdog or `memory-bus.ps1 -Action SyncAll`). It does not run in real-time.
- Maximum include depth is 1. If an included section itself contains `@include` directives, those are NOT processed.
