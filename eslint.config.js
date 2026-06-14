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
      // no-console is warn rather than error: CLI entry points (e.g. ai-memory.js,
      // mcp-memory-tools.js CLI) legitimately print to stdout, and forcing them
      // through a logger just to satisfy a lint rule is ceremony. Server code
      // should still prefer stderr / structured logging — the warn severity keeps
      // the rule visible during review so we can migrate producers over time.
      "no-console": ["warn", { allow: ["error", "warn"] }],
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-var": "error",
      "prefer-const": "warn",
    },
  },
];
