import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  validatePromotionMetadata,
  validateStructuredRecord,
} from '../../ops/memory/memory-contract.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RETRIEVAL_ROOT = path.resolve(__dirname, '../../retrieval');
const PYTHON = process.env.PYTHON
  || process.env.AI_MEMORY_PYTHON
  || (process.platform === 'win32' ? 'python' : 'python3');

const PYTHON_VALIDATOR = String.raw`
import json, sys
from schema_validation import validate_record, validate_promotion_metadata
request = json.load(sys.stdin)
if request['operation'] == 'record':
    ok, errors = validate_record(request['payload'])
    result = {'ok': ok, 'errors': errors}
elif request['operation'] == 'promotion':
    errors = validate_promotion_metadata(request['payload'])
    result = {'ok': len(errors) == 0, 'errors': errors}
else:
    raise ValueError('unknown operation')
print(json.dumps(result, ensure_ascii=False))
`;

function runPython(operation, payload) {
  const result = spawnSync(PYTHON, ['-c', PYTHON_VALIDATOR], {
    input: JSON.stringify({ operation, payload }),
    encoding: 'utf8',
    timeout: 10000,
    env: {
      ...process.env,
      PYTHONPATH: [RETRIEVAL_ROOT, process.env.PYTHONPATH]
        .filter(Boolean)
        .join(path.delimiter),
    },
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Python validator failed (${result.status}): ${result.stderr}`);
  }
  return JSON.parse(result.stdout.trim());
}

function normalizeErrorCodes(errors) {
  return [...errors]
    .map((error) => String(error).split(':', 1)[0])
    .sort();
}

function assertEquivalent(operation, payload, jsResult) {
  const pythonResult = runPython(operation, payload);
  assert.equal(pythonResult.ok, jsResult.ok);
  assert.deepEqual(
    normalizeErrorCodes(pythonResult.errors),
    normalizeErrorCodes(jsResult.errors),
  );
}

const BASE_RECORD = Object.freeze({
  schemaVersion: 2,
  id: 'record-1',
  tool: 'test',
  type: 'n',
  title: 'Test record',
  source: 'test',
  scope: 'project',
  memory_level: 'durable',
});

const RECORD_CASES = [
  ['valid minimal record', { ...BASE_RECORD }],
  ['valid optional fields', {
    ...BASE_RECORD,
    visibility: 'shared',
    sourceKind: 'event',
    tier: 3,
    content_hash: 'a'.repeat(64),
    name: 'Example',
    description: 'Description',
  }],
  ['record is not an object', []],
  ['missing schema version', (() => {
    const record = { ...BASE_RECORD };
    delete record.schemaVersion;
    return record;
  })()],
  ['unexpected schema version', { ...BASE_RECORD, schemaVersion: 999 }],
  ['missing required id', { ...BASE_RECORD, id: '' }],
  ['unknown scope', { ...BASE_RECORD, scope: 'invalid' }],
  ['unknown visibility', { ...BASE_RECORD, visibility: 'invalid' }],
  ['unknown source kind', { ...BASE_RECORD, sourceKind: 'invalid' }],
  ['unknown memory level', { ...BASE_RECORD, memory_level: 'invalid' }],
  ['tier below range', { ...BASE_RECORD, tier: 0 }],
  ['tier above range', { ...BASE_RECORD, tier: 6 }],
  ['invalid content hash', { ...BASE_RECORD, content_hash: 'not-a-hash' }],
  ['invalid name type', { ...BASE_RECORD, name: 42 }],
  ['invalid description type', { ...BASE_RECORD, description: [] }],
];

describe('structured-record validation stays equivalent across JavaScript and Python', () => {
  for (const [name, record] of RECORD_CASES) {
    test(name, () => {
      assertEquivalent('record', record, validateStructuredRecord(record));
    });
  }
});

const BASE_PROMOTION = Object.freeze({
  version: 1,
  durable_type: 'project',
  key: 'project:example',
  reason: 'confirmed across sessions',
  source_record_id: 'record-1',
  is_refresh: false,
  conflict_with: [],
});

const PROMOTION_CASES = [
  ['valid promotion', { ...BASE_PROMOTION }],
  ['missing version', (() => {
    const promotion = { ...BASE_PROMOTION };
    delete promotion.version;
    return promotion;
  })()],
  ['unknown durable type', { ...BASE_PROMOTION, durable_type: 'invalid' }],
  ['missing key', { ...BASE_PROMOTION, key: '' }],
  ['missing reason', { ...BASE_PROMOTION, reason: '' }],
  ['missing source record', { ...BASE_PROMOTION, source_record_id: '' }],
  ['invalid refresh flag type', { ...BASE_PROMOTION, is_refresh: 'yes' }],
  ['invalid conflict id', { ...BASE_PROMOTION, conflict_with: [''] }],
  ['refresh missing source fields', {
    ...BASE_PROMOTION,
    is_refresh: true,
    refresh_of_id: '',
    refresh_of_t: '',
  }],
];

describe('promotion validation stays equivalent across JavaScript and Python', () => {
  for (const [name, promotion] of PROMOTION_CASES) {
    test(name, () => {
      const errors = validatePromotionMetadata(promotion);
      assertEquivalent('promotion', promotion, { ok: errors.length === 0, errors });
    });
  }
});
