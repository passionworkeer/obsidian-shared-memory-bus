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
