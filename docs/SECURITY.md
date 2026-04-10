# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 3.x     | :white_check_mark: |
| < 3.0   | :x:                |

Security updates are released as patch versions and noted in the CHANGELOG with a `[SECURITY]` prefix.

---

## Secrets Management

The obsidian-shared-memory-bus **never hardcodes secrets**. All sensitive credentials are loaded exclusively from environment variables at runtime.

### Required Environment Variables

| Variable | Description | Example |
|---|---|---|
| `AI_MEMORY_OPENAI_API_KEY` | OpenAI API key for embeddings and completions | `sk-proj-...` |
| `AI_MEMORY_MINIMAX_API_KEY` | MiniMax API key (optional; required only if MiniMax MCP is enabled) | `Mk...` |
| `AI_MEMORY_MCP_PYTHON` | Path to a Python 3.10+ runtime for shared MCP servers | `/usr/bin/python3` |
| `AI_MEMORY_PYTHON` | Path to the primary Python runtime | `/usr/bin/python3` |
| `PIP_INDEX_URL` | Custom pip index (optional) | `https://pypi.example.com/simple` |
| `AI_MEMORY_PIP_INDEX_URL` | Custom pip index scoped to ai-memory (optional; takes precedence over `PIP_INDEX_URL`) | `https://pypi.example.com/simple` |

### How Secrets Are Used

- API keys are read by the memory bus and retrieval layer when calling embedding providers or LLM summarization endpoints.
- `AI_MEMORY_PYTHON` and `AI_MEMORY_MCP_PYTHON` are paths, not secrets, but restricting write access to these binaries is good practice — a tampered interpreter could execute arbitrary code with your API key.
- No secrets are ever written to structured memory records, `.jsonl` files, or generated artifacts.

### Best Practices

- Set environment variables in your shell profile or system environment, **not** in scripts or config files that get committed to source control.
- On Windows, use `[Environment]::SetEnvironmentVariable("AI_MEMORY_OPENAI_API_KEY", "...", "User")` to persist to the user scope without admin rights.
- On Unix, add to `~/.bashrc` or `~/.zshrc`:

```bash
export AI_MEMORY_OPENAI_API_KEY="sk-proj-..."
export AI_MEMORY_MINIMAX_API_KEY="Mk..."
export AI_MEMORY_ROOT="$HOME/.ai-memory"
```

---

## PII Redaction

The `ops/redaction.py` module detects and redacts personally identifiable information (PII) and credentials from text before that text is embedded or stored in a structured memory record.

### Built-in Detection Patterns

| Pattern | Matches |
|---|---|
| `CREDIT_CARD` | 16-digit card numbers with optional `-`, `.`, or space separators |
| `SSN` | US-format Social Security Numbers (`XXX-XX-XXXX`) |
| `API_KEY` | Strings of the form `api_key: <value>`, `token: <value>`, `secret: <value>`, `password: <value>` (8+ chars, case-insensitive) |
| `EMAIL` | Email addresses |
| `PHONE` | 10-digit US phone numbers |
| `URL_AUTH` | URLs with embedded credentials (`https://user:pass@example.com`) |

### Usage

```python
from ops.redaction import redact_sensitive, REDACTION_CONFIG

# tools mode: type-specific placeholders
cleaned = redact_sensitive("my email is alice@example.com and key: abc12345xyz")
# -> "my email is [REDACTED_EMAIL] and key: [REDACTED_API_KEY]"

# strict mode: single generic placeholder
cleaned = redact_sensitive("my email is alice@example.com", mode="strict")
# -> "my email is [REDACTED]"
```

### Pipeline Integration

Wrap any `build_entry`-style function to apply redaction automatically:

```python
from ops.redaction import add_to_python_pipeline

redacted_build_entry = add_to_python_pipeline(build_entry)
entries = redacted_build_entry(payload)
```

This sanitizes `content`, `title`, `description`, `facts`, and `concepts` fields in each record before it is written.

### Configuration via Environment Variables

| Variable | Default | Options | Description |
|---|---|---|---|
| `AI_MEMORY_REDACTION_ENABLED` | `true` | `true`, `false` | Enable/disable all redaction |
| `AI_MEMORY_REDACTION_MODE` | `tools` | `tools`, `strict` | Placeholder style |
| `AI_MEMORY_REDACTION_CUSTOM_PATTERNS` | *(none)* | `Name:regex\|...` | Custom detection patterns |

### Important: Manual Execution Required

PII redaction is **available but not yet integrated into the automated pipeline**. If your structured memory records contain sensitive data, run redaction manually on any payload before it reaches `build_entry`:

```bash
# Apply redaction to a single text field
python3 -c "
from ops.redaction import redact_sensitive
import sys
text = sys.stdin.read()
print(redact_sensitive(text))
" < sensitive-input.txt
```

Until automated pipeline integration is complete, treat `ops/redaction.py` as a pre-processing step you must invoke explicitly when handling sensitive content.

---

## Memory Contract Data Integrity

The memory contract (`ops/memory-contract.js`) enforces structural integrity for all structured records and generated artifacts.

### What Is Validated

**Structured records** (in `structured/*.jsonl`):

- Required fields are present and non-empty: `schemaVersion`, `id`, `tool`, `type`, `title`, `source`, `scope`, `memory_level`
- `schemaVersion` equals `2` (v1 records are flagged, not silently accepted)
- `scope` is one of: `user`, `feedback`, `project`, `reference`, `summary`, `task`, `run`
- `memory_level` is one of: `durable`, `session`, `event`, `task`
- `source_kind` is one of: `writeback`, `hook`, `session`, `event`, `blackboard`, `run`, `cron`, `task`
- `content_hash`, if present, is a valid 64-character SHA-256 hex string
- `promotion` metadata, if present, has a known `version` and valid `durable_type`

**Generated artifacts** (`generated/MEMORY-LAYERS.json`, `generated/HANDOFF.json`, `generated/AUTO-DREAM.json`):

- `contractVersion` equals `2`
- `recordSchemaVersion` equals `2`
- `sourceStructuredSignature` matches the current hash of the structured layer

### Unknown Schema Versions Are Flagged, Not Silently Accepted

If `check-memory-integrity.js` encounters a record with `schemaVersion` other than `2`, it is counted as an **invalid record** and listed in `issues` under `unexpected-schema-version`. The process exit code is `1` in `--strict` mode. There is no silent fallback — the record is readable but the integrity report will always surface the mismatch.

### Running the Integrity Checker

```bash
# Human-readable summary
node ~/.ai-memory/ops/check-memory-integrity.js

# JSON output for automation
node ~/.ai-memory/ops/check-memory-integrity.js --json

# Fail the build/CI if anything is wrong
node ~/.ai-memory/ops/check-memory-integrity.js --strict
```

### content_hash Fingerprinting

Every structured record can carry a `content_hash` field — a SHA-256 hex digest of the record's meaningful content fields. This fingerprint enables deduplication and tamper detection: if the record body changes without updating the hash, the integrity checker flags `invalid-content-hash`.

---

## Data Shared Across Clients

**All structured memory records are shared with every connected client.** This is the intended design of the shared memory bus — it provides a common factual context to all agents on the same machine. Operators must understand this exposure model before placing sensitive information into the memory bus.

### What Is Shared

When a record is written to any `structured/*.jsonl` file, it becomes visible to:

- All Claude Code instances on the same machine (via the shared MCP memory server)
- All OpenClaw agents on the same machine (via the shared MCP memory server)
- Any other tool that calls `search_shared_memory`, `get_memory_records`, or `get_memory_timeline`

Shared fields include: `source_kind`, `scope`, `content`, `facts`, `concepts`, `files_read`, `files_modified`, `title`, and all structured metadata.

### Visibility Annotations

Records may carry a `visibility` field set to `shared` (the default) or `private`. Currently, `private` records are stored in the same structured layers as shared records; the visibility flag is recorded but enforcement of `private` isolation between clients is the responsibility of the calling tool. When writing sensitive records, set `visibility: "private"` and apply PII redaction before writing.

### Scopes and Their Intended Sensitivity

| Scope | Typical sensitivity | Recommendation |
|---|---|---|
| `user` | High — user preferences and personal context | Apply redaction before writing |
| `feedback` | Medium — user corrections | Apply redaction before writing |
| `project` | Low-Medium — working context | Generally safe to share |
| `reference` | Low — documentation and reference | Safe to share |
| `summary` | Medium — derived summaries may contain context | Apply redaction before writing |
| `task` | Low — per-task state | Generally safe to share |
| `run` | Low — per-invocation observations | Generally safe to share |

---

## Token Truncation

Long prompts and file contents are sampled, not fully embedded, to stay within the token budget of embedding models.

### Prompt Sampling

When a structured record is built from a long tool interaction (e.g. a `memory_wake_up` or `search_shared_memory` call with a long query), the `content` field is written as the full query text. If the query exceeds the configured token budget, the embedding pipeline truncates or samples the content rather than discarding the record.

### File Content Sampling

When building memory entries from file reads, the `files_read` array may contain truncated snippets rather than full file contents. The retrieval layer uses `snippetWindow` parameters to bound the context around each match.

### Token Budget Tracking

Embedding operations track approximate token usage and log warnings when the budget is exceeded. Configure the budget via `AI_MEMORY_EMBEDDING_MAX_TOKENS` (default: derived from the embedding model's context window, typically 8192 tokens for OpenAI `text-embedding-3-small`).

---

## Vulnerability Reporting

If you discover a security vulnerability, please report it responsibly.

**Do NOT** create a public GitHub issue for security vulnerabilities.

Please use [GitHub's private vulnerability reporting](https://github.com/passionworkeer/obsidian-shared-memory-bus/security/advisories/new) to submit a security advisory.

Include in your report:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Any suggested fixes (optional)

Response timeline: We aim to acknowledge within 48 hours and provide a detailed response within 7 days.

---

## Security Best Practices Summary

| Practice | How This Project Enforces It |
|---|---|
| No hardcoded secrets | All API keys loaded from `AI_MEMORY_*` env vars only |
| PII redaction available | `ops/redaction.py` provides pattern-based scrubbing; must be run manually before embedding sensitive data |
| Schema validation on write | `ops/memory-contract.js` rejects records missing required fields or with unknown schema versions |
| Content hash integrity | Optional `content_hash` SHA-256 field on every record; checked by integrity tool |
| Data exposure model documented | `scope` and `visibility` fields annotate sensitivity; docs explain the shared bus exposure model |
| Token budget enforced | Embedding pipeline samples/truncates content to stay within model limits |
| Upgrade path documented | `docs/MIGRATION.md` explains how to re-run integrity checks and rebuild after upgrading |
