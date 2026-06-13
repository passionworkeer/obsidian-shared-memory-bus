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
  {
    files: ["**/*.cjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        require: "readonly",
        module: "readonly",
        exports: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        global: "readonly",
        globalThis: "readonly",
      },
    },
  },
  {
    files: ["**/*.mjs", "**/*.js"],
    ignores: ["**/*.cjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
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
        fetch: "readonly",
      },
    },
    rules: {
      "no-console": ["error", { allow: ["error", "warn"] }],
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-var": "error",
      "prefer-const": "warn",
    },
  },
];
