# Error Codes

## Prefix Conventions

| Prefix | Layer |
|--------|-------|
| `python-runtime-*` | Python runtime errors |
| `embedding-*` | Embedding generation errors |
| `memory-*` | Memory bus errors |
| `mcp-*` | MCP transport errors |
| `openai-compatible-*` | OpenAI API errors |

## Embedding Errors (embedding-provider-registry.js)

| Code | Meaning |
|------|---------|
| `python-runtime-unavailable` | Python runtime not available |
| `embedding-process-exit-N` | Python process exited with code N |
| `invalid-embedding-json` | Python output was not valid JSON |
| `openai-compatible-http-429` | Rate limited |
| `openai-compatible-http-5XX` | Server error |
| `openai-compatible-count-mismatch` | Vector count mismatch |
| `openai-compatible-empty-vector` | Empty embedding returned |
| `missing-openai-base-url` | OpenAI-compatible base URL not configured |
| `missing-openai-api-key` | OpenAI-compatible API key not configured |
| `fetch-unavailable` | Fetch API not available in environment |
| `{provider}-embedding-failed` | Generic embedding provider failure |

## Semantic Search Errors (retrieval/semantic-search.py)

| Code | Meaning |
|------|---------|
| `missing-embeddings-index` | No embeddings index found |
| `embedding-schema-version-mismatch` | Index schema version mismatch |
| `embedding-config-mismatch` | Embedding config changed |
| `embedding-dimension-mismatch` | Vector dimension mismatch |

## Error Handling

**Python runtime errors**: Check Python installation and dependencies.

**Embedding errors**: Verify API keys, network connectivity, and model availability.

**Memory bus errors**: Run `ops/check-memory-integrity.js --strict`.

**MCP transport errors**: Restart the MCP server and check logs.

## Memory Integrity / Contract Errors (ops/memory-contract.js)

Validated by `buildMemoryIntegrityReport`. Current contract version: **2**, record schema version: **2**.

### Structured Layer Errors

| Code | Meaning |
|------|---------|
| `invalid-records` | Record(s) failed schema validation |
| `malformed-lines` | Line(s) in JSONL could not be parsed |
| `duplicate-ids` | Duplicate record IDs across governed layers |

### Generated Artifact Errors

| Code | Meaning |
|------|---------|
| `generated-artifacts-missing` | A required generated artifact file does not exist |
| `generated-artifacts-stale-or-invalid` | Artifact source signature does not match current structured memory |
| `generated-artifacts-missing-source-signature` | Artifact lacks a source structured signature |
| `generated-artifacts-contract-mismatch` | Artifact contract or record schema version is out of date |

### Validation Errors

| Code | Meaning |
|------|---------|
| `record-not-object` | A JSONL line parsed but is not an object |
| `unexpected-schema-version` | Record schema version differs from current (2) |
| `unknown-scope` | Record scope is not in the allowed set |
| `unknown-visibility` | Record visibility is not `shared` or `private` |
| `unknown-source-kind` | Record sourceKind is not in the allowed set |
| `unknown-memory-level` | Record memoryLevel is not in the allowed set |

## Script Execution Errors (shared-mcp/*.js)

| Code | Meaning |
|------|---------|
| `embeddings-script-missing` | Embeddings generation script not found |
| `memory-bus-script-missing` | Memory bus generation script not found |
| `semantic-search-exit-N` | Semantic search script exited with code N |
| `search-script-missing` | Search worker script not found |
| `refresh-derived-artifacts-exit-N` | Derived artifacts refresh script exited with code N |

## Runtime Configuration Errors (bus/runtime-config.js)

| Code | Meaning |
|------|---------|
| `runtime-config-invalid` | Runtime configuration file is invalid |
| `embedding-selection-update-requires-profile-provider-or-clear-flag` | Cannot update embedding selection without profile or provider |
| `unknown-embedding-profile` | Requested embedding profile not found |
| `unknown-embedding-provider` | Requested embedding provider not found |

## Server Request Validation Errors (retrieval/semantic-search.py)

| Code | Meaning |
|------|---------|
| `query is required` | Search query parameter is missing |
| `ids must be an array` | Record IDs parameter must be an array |
| `ids cannot be empty` | Record IDs array cannot be empty |
| `anchor_id is required` | Timeline anchor ID parameter is missing |
| `anchor_id not found` | Timeline anchor ID not found in records |
| `unsupported-action` | Requested server action is not supported |
