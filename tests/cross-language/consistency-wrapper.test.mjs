import { createRequire } from 'node:module';

// consistency.test.js predates the repository-wide ESM migration. Keep its
// extensive assertions while supplying a test-file-relative CommonJS loader.
globalThis.require = createRequire(new URL('./consistency.test.js', import.meta.url));

try {
  await import('./consistency.test.js');
} finally {
  delete globalThis.require;
}
