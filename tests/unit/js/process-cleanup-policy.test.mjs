import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  killZombieNpxProcesses,
  shouldRunGlobalZombieCleanup,
} from '../../../shared-mcp/proto/child-process.mjs';

describe('global Windows npx cleanup policy', () => {
  test('is disabled by default on Windows', () => {
    assert.equal(shouldRunGlobalZombieCleanup({}, 'win32'), false);
  });

  test('is always disabled on non-Windows platforms', () => {
    assert.equal(
      shouldRunGlobalZombieCleanup(
        { AI_MEMORY_FORCE_GLOBAL_NPX_CLEANUP: 'true' },
        'linux',
      ),
      false,
    );
  });

  test('requires an explicit truthy opt-in on Windows', () => {
    for (const value of ['1', 'true', 'yes', 'on', ' TRUE ']) {
      assert.equal(
        shouldRunGlobalZombieCleanup(
          { AI_MEMORY_FORCE_GLOBAL_NPX_CLEANUP: value },
          'win32',
        ),
        true,
      );
    }
  });

  test('does not invoke a system scan when disabled', () => {
    assert.equal(killZombieNpxProcesses({ env: {}, platform: 'win32' }), 0);
  });
});
