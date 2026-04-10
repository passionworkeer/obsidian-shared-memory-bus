# Archived: shared-mcp/python-runtime.cjs

**Archived:** 2026-04-10
**Reason:** Orphaned - not imported anywhere in the installed runtime or source tree

## What It Was

A CJS (CommonJS) wrapper module that provided `require()`-compatible access to Python runtime resolution utilities from the `bus/` directory. It offered:

- `resolvePythonCommand()` - returns the resolved Python executable path
- `withResolvedPython(env)` - merges `AI_MEMORY_PYTHON` into a process env object

## Why It Was Archived

- NOT listed in `SharedMcpFiles` in `scripts/install-layout.psd1`
- NOT referenced by any `.mjs`, `.js`, `.ps1`, `.psm1`, or `.json` file in the project
- The bus (`bus/python-runtime.js`) is the canonical ESM source; this was a CJS compatibility layer with no active consumers

## Original File (41 lines)

```javascript
"use strict";

const fs = require("fs");
const path = require("path");
function resolveRuntimeHelperPath() {
  const candidates = [
    path.join(__dirname, "..", "python-runtime.js"),
    path.join(__dirname, "..", "bus", "python-runtime.js"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[candidates.length - 1];
}

const { resolvePythonRuntime } = require(resolveRuntimeHelperPath());

function resolvePythonCommand() {
  const runtime = resolvePythonRuntime();
  return runtime && runtime.available ? runtime.command : "";
}

function withResolvedPython(env = process.env) {
  const runtime = resolvePythonRuntime();
  if (!runtime || !runtime.available) {
    return { ...env };
  }
  return {
    ...env,
    AI_MEMORY_PYTHON: runtime.command,
  };
}

module.exports = {
  resolvePythonCommand,
  withResolvedPython,
};
```

## Replacement

The canonical Python runtime utilities live in:
- `bus/python-runtime.js` (ESM, the source of truth)

If a CJS entry point is ever needed again, it can be regenerated from `bus/python-runtime.js`.
