/**
 * tests/unit/js/domain-error.test.js — DomainError unit tests.
 *
 * Covers: code/message/cause fields, toJSON() shape, toErrorPayload()
 * adapter for non-DomainError inputs, prototype chain, and that
 * `instanceof Error` still holds so generic catch blocks work.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DomainError, COMMON_CODES, toErrorPayload } from '../../../bus/domain-error.js';

test('DomainError sets name, code, message, and is instanceof Error', () => {
  const e = new DomainError(COMMON_CODES.NOT_FOUND, 'thing missing');
  assert.equal(e.name, 'DomainError');
  assert.equal(e.code, 'NOT_FOUND');
  assert.equal(e.message, 'thing missing');
  assert.ok(e instanceof Error);
});

test('DomainError carries an optional cause', () => {
  const root = new Error('disk gone');
  const e = new DomainError(COMMON_CODES.IO_ERROR, 'read failed', { cause: root });
  assert.equal(e.cause, root);
  assert.equal(e.cause.message, 'disk gone');
});

test('toJSON returns the canonical wire envelope', () => {
  const e = new DomainError(COMMON_CODES.CONFLICT, 'dup key', { cause: 'email' });
  assert.deepEqual(e.toJSON(), {
    error: { code: 'CONFLICT', message: 'dup key', cause: 'email' },
  });
});

test('toJSON omits cause when not provided', () => {
  const e = new DomainError(COMMON_CODES.TIMEOUT, 'slow');
  assert.deepEqual(e.toJSON(), { error: { code: 'TIMEOUT', message: 'slow' } });
});

test('toErrorPayload wraps plain Error as INTERNAL', () => {
  const out = toErrorPayload(new Error('boom'));
  assert.deepEqual(out, { error: { code: 'INTERNAL', message: 'boom' } });
});

test('toErrorPayload passes DomainError through', () => {
  const e = new DomainError(COMMON_CODES.PERMISSION_DENIED, 'nope');
  assert.deepEqual(toErrorPayload(e), e.toJSON());
});

test('toErrorPayload handles non-Error inputs without throwing', () => {
  assert.deepEqual(toErrorPayload(null), { error: { code: 'INTERNAL', message: 'null' } });
  assert.deepEqual(toErrorPayload('oops'), { error: { code: 'INTERNAL', message: 'oops' } });
});

test('COMMON_CODES is frozen and contains expected entries', () => {
  assert.ok(Object.isFrozen(COMMON_CODES));
  for (const k of ['INVALID_INPUT', 'NOT_FOUND', 'PERMISSION_DENIED', 'CONFLICT', 'TIMEOUT', 'IO_ERROR', 'EXTERNAL_SERVICE', 'INTERNAL']) {
    assert.ok(k in COMMON_CODES, `missing ${k}`);
  }
});
