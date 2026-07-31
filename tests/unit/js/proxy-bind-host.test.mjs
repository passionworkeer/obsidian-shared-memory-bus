import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveProxyBindHost } from '../../../shared-mcp/proto/bind-host.mjs';

describe('proxy bind host policy', () => {
  test('defaults to loopback for source installs', () => {
    assert.equal(resolveProxyBindHost({}), '127.0.0.1');
  });

  test('allows an explicit all-interface bind for containers', () => {
    assert.equal(
      resolveProxyBindHost({ AI_MEMORY_BIND_HOST: '0.0.0.0' }),
      '0.0.0.0',
    );
  });

  test('rejects arbitrary bind hosts', () => {
    assert.throws(
      () => resolveProxyBindHost({ AI_MEMORY_BIND_HOST: '192.0.2.10' }),
      /Unsupported AI_MEMORY_BIND_HOST/,
    );
  });
});
