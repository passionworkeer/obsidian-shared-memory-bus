/**
 * eslint.config.js — flat config for ESLint 10.x.
 *
 * Replaces the old .eslintrc.cjs (incompatible with ESLint 10) and adds
 * a root-level lint surface so the entire project is covered, not just
 * shared-mcp/ as the previous config did.
 *
 * Rules:
 *   - no-console: only allow error/warn (production code should use the
 *                 shared-mcp structured logger or print to stderr).
 *   - no-unused-vars: warn (catches dead code).
 *   - Internal helper prefix: _ allowed (matches the prior convention).
 *
 * Excluded paths mirror .eslintignore.
 */

import js from "@eslint/js";

export default [
  {
    ignores: [
      "node_modules/**",
      "bus/node_modules/**",
      "shared-mcp/node_modules/**",
      "ops/node_modules/**",
      "cli/node_modules/**",
      "~/.ai-memory/**",
      "**/*.min.js",
      "dist/**",
      "build/**",
      "generated/**",
      "inbox/**",
      "imported/**",
      "structured/**",
      "cache/**",
      "coverage/**",
    ],
  },
  js.configs.recommended,
  // Base config applies to all JS files including .cjs.
  // The .cjs block below overrides sourceType to "commonjs" and removes
  // ESM-only globals.
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        // Builtins — available in both ESM and CJS contexts.
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        setImmediate: "readonly",
        globalThis: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        AbortController: "readonly",
        AbortSignal: "readonly",
        fetch: "readonly",
        // `require` is available in CJS and via createRequire in ESM.
        // Declaring it as a global silences no-undef for .cjs files and
        // is harmless for .mjs/.js files that don't use it.
        require: "readonly",
        module: "readonly",
        exports: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        global: "readonly",
      },
    },
    rules: {
      // no-console: error severity so the rule actually blocks
      // accidental console.log/info calls in PR review.
      //
      // Two carve-outs via per-file overrides below:
      //   - CLI entry points and operational scripts (ops/stress, ops/verify,
      //     retrieval/eval, scripts under cli/, build/check tools in ops/)
      //     legitimately print to stdout — they are user-facing.
      //   - Anything else (bus/, shared-mcp/, library code) must use the
      //     structured logger (shared-mcp/metrics/source.js) or console.error/
      //     console.warn only.
      "no-console": ["error", { allow: ["error", "warn"] }],
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-var": "error",
      "prefer-const": "warn",
    },
  },
  // CLI / operational scripts — console.log/info are legitimate user output.
  {
    files: [
      "cli/**/*.js",
      "bus/generate-embeddings.js", // CLI embedding index builder (has direct-run check)
      "ops/stress/**/*.js",
      "ops/verify/**/*.js",
      "ops/check/**/*.js",
      "ops/build/**/*.js",
      "ops/bench/**/*.js",
      "ops/adapters/**/*.js",
      "ops/migrations/**/*.js",
      "ops/setup/**/*.js",
      "ops/entity/**/*.js",
      "ops/memory/memory-archival.js",     // archival CLI script
      "ops/memory/memory-promotion-resolver.js", // promotion CLI script
      "ops/memory/memory-promotion-scorer.js",   // promotion CLI script
      "ops/knowledge/knowledge-graph/cli.js",
      "retrieval/eval/**/*.js",
      "shared-mcp/proto/**/*.mjs",
    ],
    rules: {
      "no-console": "off",
    },
  },
];
