# Stop Hook LLM Extract

This hook runs after a Claude Code session stops. It slices the transcript, asks a small local LLM to extract structured facts, and writes those facts into the local `.ai-memory` store.

## Outputs

- `projects/{project}.jsonl`
  Per-project structured facts written by the stop hook.
- `pending-extractions.jsonl`
  Retry queue for extractions that timed out or failed.

## Inputs

The hook reads Claude Code's JSON payload from `stdin` and expects these fields when available:

```json
{
  "session_id": "abc123",
  "cwd": "E:/project",
  "transcript_path": "C:/Users/name/.claude/sessions/.../transcript.json"
}
```

It also supports the legacy CLI form:

```bash
node hooks/stop-hook-llm-extract/stop-extract.mjs <cwd> <session_id> <transcript_path>
```

## Environment

- `AI_MEMORY_STORE`
  Optional custom store root. Defaults to the resolved `.ai-memory` path.
- `AI_MEMORY_MODEL`
  Optional local extraction model override.
- `ANTHROPIC_BASE_URL`
  Local loopback-compatible Anthropic proxy, default `http://127.0.0.1:15721`.

## Behavior

1. Validate the transcript path.
2. Skip sessions that were already processed for the same project JSONL.
3. Slice the transcript with `src/transcript-slicer.mjs`.
4. Extract `facts`, `decisions`, `entities`, `summary`, and `session_type`.
5. Append the structured record to `projects/{project}.jsonl`.
6. If extraction fails, queue the transcript in `pending-extractions.jsonl` and write a failed placeholder record.

## Notes

- The hook now writes to `.ai-memory` directly instead of an Obsidian inbox.
- `projects/{project}.jsonl` is the preferred durable write path for automatic extraction.
- Manual fallback writeback still goes through `inbox/<agent>.md` when needed.
