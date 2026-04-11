# KG Schema Migrations

This directory holds versioned, idempotent migrations for the knowledge-graph SQLite schema.

## kg-v1-to-v2

**Purpose**: Adds time-dimension and source-scope fields to the `triples` table.

**New columns added to `triples`**:

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `valid_from` | TEXT | NULL | ISO timestamp — fact becomes valid at this time |
| `valid_to` | TEXT | NULL | ISO timestamp — fact expires at this time (NULL = currently valid) |
| `confidence` | REAL | 0.5 | Confidence score 0.0–1.0; auto-increments when same entity is seen across multiple projects |
| `source_scope` | TEXT | 'project' | Source boundary: `'project'` \| `'shared'` \| `'archive'` |

**Idempotency**: Safe to run multiple times. The migration checks `schema_versions` and skips if v2 is already recorded.

**Run manually**:

```bash
node ops/migrations/kg-v1-to-v2.js
```

**Expected output** (first run):

```
[kg-migration] added valid_from
[kg-migration] added valid_to
[kg-migration] added confidence
[kg-migration] added source_scope
[kg-migration] v2 applied successfully
```

**Expected output** (subsequent runs):

```
[kg-migration] v2 already applied, skipping
```

---

## Future migrations

### kg-v2-to-v3 (reserved)
- Add `embedding` BLOB column for vector similarity search
- Requires: `ALTER TABLE entities ADD COLUMN embedding BLOB`

### kg-v3-to-v4 (reserved)
- Add `triples.source_file` deduplication index
- Add full-text search (FTS5) virtual table
