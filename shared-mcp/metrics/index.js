// shared-mcp/metrics/index.js
//
// Aggregate entrypoint for the metrics pipeline. Re-exports the public
// surface of source.js, compute.js, and server.js in a single import.
//
// External code should prefer the canonical re-export at
// shared-mcp/omni-metrics.js for backward compatibility with the
// pre-split module. This file exists so the three new modules can be
// consumed as a unit when the legacy compatibility shim is not desired.

export * from "./source.js";
export * from "./compute.js";
export * from "./server.js";
