---
title: Architecture Decision Records
description: Key architectural decisions — why they were made, what alternatives were considered, and what was decided.
platform: cross-platform
---

# Architecture Decision Records / 架构决策记录

> English: A log of significant architectural decisions made during the development of this project, with context, alternatives considered, and consequences.
> 中文：本项目开发过程中做出的重要架构决策的记录，包含背景、考虑过的替代方案和后果。

## ADR Index / ADR 索引

| ID | Title | Status | Date |
|----|-------|--------|------|
| ADR-002 | Unified Memory Architecture v2 | Active | 2026-04-03 |
| ADR-003 | Cross-Platform Abstraction | Active | 2026-03-15 |
| ADR-004 | WAL Concurrency Strategy | Active | 2026-03-20 |

> **Note**: ADR-001 was superseded by ADR-002. The full text of ADR-002 is in [`docs/adr/ADR-002-unified-memory-architecture-v2.md`](../adr/ADR-002-unified-memory-architecture-v2.md).

---

## ADR-003: Cross-Platform Abstraction

**Status**: Active
**Date**: 2026-03-15
**Deciders**: Architect

---

### Context / 背景

The shared memory bus must run on Windows, macOS, and Linux. Several behaviours differ per OS in ways that affect core functionality:

- **Vault config path**: Windows uses `%APPDATA%\obsidian\obsidian.json`; macOS uses `~/Library/Application Support/obsidian/obsidian.json`; Linux uses `~/.config/obsidian/obsidian.json`
- **Store default path**: Windows defaults to `E:\.ai-memory`; macOS/Linux default to `~/.ai-memory`
- **Python binary name**: `python` on Windows, `python3` on macOS/Linux
- **Watchdog recovery**: VBScript on Windows (for hidden Startup folder launch), Bash on macOS/Linux
- **Background process launch**: `Start-Process -WindowStyle Hidden` on Windows; POSIX `&` / `nohup` on macOS/Linux
- **Startup registration**: Windows Startup folder; macOS LaunchAgent; Linux systemd `--user` or XDG autostart
- **PowerShell**: `powershell.exe` on Windows; `pwsh` on macOS/Linux

Without abstraction, these differences would scatter `if (platform === 'win32')` checks throughout the codebase, making it hard to test, maintain, and extend.

### Decision / 决策

Introduce a **platform adapter** pattern in `bus/platform/`. Each platform gets a dedicated module that exports a unified interface:

```
bus/platform/
├── index.js      # Detection + export (singleton)
├── windows.js    # Windows adapter
├── darwin.js     # macOS adapter
└── linux.js      # Linux adapter
```

All business logic imports from `bus/platform/index.js` and calls adapter methods. Platform-specific code is isolated to the adapter modules.

### Alternatives Considered / 考虑过的替代方案

**A. Conditional `if` checks throughout the codebase**
- Pros: Simple, no new abstractions
- Cons: Scattered platform checks; easy to miss one; hard to test; makes adding new platforms O(n) across all files

**B. Environment variable overrides only**
- Pros: No OS detection code needed
- Cons: Users must set many variables manually; defaults are wrong for each platform; verbose

**C. Single unified module with switch statement**
- Pros: Single file to maintain
- Cons: Becomes large and unwieldy as platform-specific logic grows; hard to test in isolation

**D. Platform adapter per OS (chosen)**
- Pros: Clean separation; each adapter is small and testable; adding a new platform means adding one file; the shared interface is a contract
- Cons: Slight upfront complexity; need to keep interface in sync across adapters

### Consequences / 后果

**Positive**:
- Platform-specific logic is isolated to 3 small files (~200 lines each)
- The shared interface serves as documentation and a testing contract
- Adding FreeBSD, for example, requires one new file + one entry in `index.js`
- CI can test each platform adapter in isolation

**Negative**:
- A new abstraction layer means new places where drift can occur (e.g., one adapter gets updated but not another)
- Mitigation: the adapter interface is narrow (5 methods + 2 config objects) and stable

**Neutral**:
- Windows adapter is the most complex because it handles drive detection and registry environment variable reads
- POSIX adapters (macOS/Linux) are nearly identical — the only differences are Obsidian config paths and startup registration details

### Implementation Notes / 实现笔记

The adapter interface is documented in [`docs/architecture/PLATFORM_ABSTRACTION.md`](../architecture/PLATFORM_ABSTRACTION.md).

Vault resolution uses **runtime caching** (module-level `_adapter` singleton) so repeated calls are fast. Pass `{ refresh: true }` to bypass the cache when testing or after a config change.

---

## ADR-004: WAL Concurrency Strategy

**Status**: Active
**Date**: 2026-03-20
**Deciders**: Architect

---

### Context / 背景

The knowledge graph and retrieval index use SQLite. Multiple Node.js and Python processes may read/write concurrently. SQLite default journal mode (`DELETE`) holds an exclusive write lock for the duration of a transaction, blocking all readers.

At startup, the system checks the SQLite version and sets `PRAGMA journal_mode = WAL` plus `PRAGMA busy_timeout = 5000` (5 seconds) to allow concurrent reads during writes. This is set in `retrieval/schema_validation.py` and `bus/knowledge-graph.js`.

### Decision / 决策

1. **WAL mode**: Enables concurrent readers during a write transaction. Multiple readers can proceed in parallel; only writers block each other.
2. **busy_timeout = 5000 ms**: Readers wait up to 5 seconds for a write lock before failing. This prevents transient lock contention from causing immediate failures during heavy concurrent access.
3. **PRAGMA retry on SQLite `SQLITE_BUSY`**: Python retrieval uses a retry loop with exponential backoff for `SQLITE_BUSY` errors, retrying up to 3 times with 100ms initial delay.
4. **No native Node `sqlite3`**: The OpenClaw blackboard daemon and shared `memory` MCP use Python's standard-library `sqlite3` instead of the native Node `sqlite3` package, reducing native module build issues across platforms.

### Alternatives Considered / 考虑过的替代方案

**A. Default DELETE journal mode**
- Cons: Blocks all readers during writes; unacceptable under concurrent multi-agent access

**B. `PRAGMA locking_mode = NORMAL`**
- Cons: Does not solve the concurrency problem; locking is at the database level, not transaction level

**C. PostgreSQL / external database**
- Cons: Adds a running database server dependency; goes against the local-first, zero-infrastructure philosophy

**D. SQLite WAL + busy_timeout + retry (chosen)**
- Pros: Zero infrastructure; works across Windows, macOS, Linux; handles concurrent access gracefully; recoverable under contention
- Cons: WAL files are additional files on disk (`.db-wal`, `.db-shm`); `busy_timeout` adds latency under extreme contention (but 5 s is very conservative)

### Consequences / 后果

**Positive**:
- Multiple concurrent readers work without blocking each other
- Concurrent writes are serialised by SQLite's lock mechanism but do not crash
- No external database server needed

**Negative**:
- WAL mode creates two extra files alongside the SQLite database: `.db-wal` and `.db-shm`
- Under very heavy write contention, `busy_timeout` adds up to 5 s latency per blocked operation
- WAL files must be included in backups alongside the main `.db` file

**Neutral**:
- WAL cleanup happens automatically when the last connection closes, but long-running servers may accumulate WAL files; periodic `PRAGMA wal_checkpoint(TRUNCATE)` can reclaim space if needed

### Monitoring / 监控

Check `memory_status` for `claudeMem.ok` and search worker health. If `SQLITE_BUSY` errors appear in logs, the system is under extreme write contention — consider reducing the watchdog polling frequency or batching writes.

---

## Adding New ADRs / 添加新 ADR

To add a new ADR:

1. Create `docs/adr/ADR-NNN-title-slug.md` using this template:

```markdown
# ADR-NNN: Title

**Status**: Proposed | Active | Deprecated | Superseded
**Date**: YYYY-MM-DD
**Deciders**: ...
**Supersedes**: ADR-XXX (if applicable)

---

## Context

## Decision

## Alternatives Considered

## Consequences
```

2. Add it to the ADR Index table above in this file.
3. Keep the status current — mark superseded ADRs with their replacement ID.

**ADR numbering**: Use `NNN` as a zero-padded 3-digit number. The next available is `ADR-005`.
