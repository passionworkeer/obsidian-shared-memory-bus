// Runtime shim for the embedding-provider implementation.
//
// The historical implementation depended on CommonJS `require` and an
// unimported `spawn` identifier. Keep its public API stable while supplying
// those dependencies explicitly, then load the implementation as ESM.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const previousSpawn = globalThis.spawn;
const previousRequire = globalThis.require;

globalThis.spawn = spawn;
globalThis.require = createRequire(new URL('./embedding-provider-registry-core.mjs', import.meta.url));

let implementation;
try {
  implementation = await import('./embedding-provider-registry-core.mjs');
} finally {
  if (previousSpawn === undefined) delete globalThis.spawn;
  else globalThis.spawn = previousSpawn;

  if (previousRequire === undefined) delete globalThis.require;
  else globalThis.require = previousRequire;
}

export const buildEmbeddingConfigHash = implementation.buildEmbeddingConfigHash;
export const createEmbeddingProviderRegistry = implementation.createEmbeddingProviderRegistry;
export const getProviderHost = implementation.getProviderHost;
export const normalizeEmbeddingAdapter = implementation.normalizeEmbeddingAdapter;
