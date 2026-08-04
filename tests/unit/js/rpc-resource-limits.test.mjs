import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_CHILD_FRAME_BYTES,
  MAX_JSONRPC_BATCH,
  MAX_JSONRPC_DEPTH,
  ResourceLimitError,
  childBuffer,
  pendingRequests,
  processChildStdout,
  readJsonBody,
  setActiveInflight,
  setChild,
  setChildBuffer,
  validateRpcPayloadComplexity,
} from '../../../shared-mcp/proto/rpc.mjs';
import { Readable } from 'node:stream';

function resetState() {
  for (const [, pending] of pendingRequests) {
    clearTimeout(pending.timeout);
  }
  pendingRequests.clear();
  setActiveInflight(0);
  setChildBuffer('');
  setChild(null);
}

function requestFromJson(value) {
  const request = new Readable({ read() {} });
  process.nextTick(() => {
    request.push(JSON.stringify(value));
    request.push(null);
  });
  return request;
}

test.afterEach(resetState);

test('unterminated oversized child frame clears residual state and terminates the child', () => {
  let killSignal = null;
  setChild({
    killed: false,
    kill(signal) {
      killSignal = signal;
      this.killed = true;
      return true;
    },
  });

  let rejected = null;
  pendingRequests.set('pending-1', {
    resolve: () => {},
    reject: (error) => { rejected = error; },
    timeout: null,
  });
  setActiveInflight(1);

  const accepted = processChildStdout(Buffer.alloc(MAX_CHILD_FRAME_BYTES + 1, 0x61));

  assert.equal(accepted, false);
  assert.equal(killSignal, 'SIGKILL');
  assert.equal(childBuffer, '');
  assert.equal(pendingRequests.size, 0);
  assert.match(rejected?.message || '', /unterminated child JSON-line frame limit exceeded/);
});

test('oversized completed child frame is rejected before JSON parsing', () => {
  let killed = false;
  setChild({
    killed: false,
    kill() {
      killed = true;
      this.killed = true;
      return true;
    },
  });

  const frame = `${'x'.repeat(MAX_CHILD_FRAME_BYTES + 1)}\n`;
  const accepted = processChildStdout(Buffer.from(frame, 'utf8'));

  assert.equal(accepted, false);
  assert.equal(killed, true);
  assert.equal(childBuffer, '');
});

test('batch limit rejects the payload before any item can be dispatched', async () => {
  const payload = Array.from(
    { length: MAX_JSONRPC_BATCH + 1 },
    (_, index) => ({ jsonrpc: '2.0', id: index, method: 'ping' }),
  );

  assert.throws(
    () => validateRpcPayloadComplexity(payload),
    (error) => error instanceof ResourceLimitError
      && error.code === -32001
      && error.statusCode === 413
      && /batch limit exceeded/.test(error.message),
  );

  await assert.rejects(
    () => readJsonBody(requestFromJson(payload)),
    (error) => error instanceof ResourceLimitError && /batch limit exceeded/.test(error.message),
  );
});

test('excessive JSON nesting is rejected with an explicit resource-limit error', () => {
  let payload = { value: 'leaf' };
  for (let index = 0; index < MAX_JSONRPC_DEPTH; index += 1) {
    payload = { nested: payload };
  }

  assert.throws(
    () => validateRpcPayloadComplexity(payload),
    (error) => error instanceof ResourceLimitError
      && error.code === -32001
      && /depth limit exceeded/.test(error.message),
  );
});

test('maximum supported batch and ordinary nested requests remain valid', () => {
  const batch = Array.from(
    { length: MAX_JSONRPC_BATCH },
    (_, index) => ({
      jsonrpc: '2.0',
      id: index,
      method: 'tools/call',
      params: { name: 'memory_status', arguments: {} },
    }),
  );

  assert.equal(validateRpcPayloadComplexity(batch), batch);
});
