import test from 'node:test';
import assert from 'node:assert/strict';

import { findUnpinnedActionRefs } from '../../../scripts/check-action-pins.mjs';

const FULL_SHA = '0123456789abcdef0123456789abcdef01234567';

test('rejects mutable major-version action references', () => {
  const workflow = `steps:\n  - uses: owner/action@v1\n`;
  const violations = findUnpinnedActionRefs(workflow, 'fixture.yml');

  assert.equal(violations.length, 1);
  assert.equal(violations[0].actionRef, 'owner/action@v1');
  assert.equal(violations[0].line, 2);
});

test('accepts full commit SHAs and adjacent version comments', () => {
  const workflow = `steps:\n  - uses: owner/action@${FULL_SHA} # v1.2.3\n`;

  assert.deepEqual(findUnpinnedActionRefs(workflow), []);
});

test('accepts local actions and reusable workflows', () => {
  const workflow = `steps:\n  - uses: ./actions/build\n  - uses: ./.github/workflows/reusable.yml\n`;

  assert.deepEqual(findUnpinnedActionRefs(workflow), []);
});

test('rejects short SHAs and missing revisions', () => {
  const workflow = `steps:\n  - uses: owner/action@0123456\n  - uses: owner/action\n`;
  const violations = findUnpinnedActionRefs(workflow);

  assert.equal(violations.length, 2);
});
