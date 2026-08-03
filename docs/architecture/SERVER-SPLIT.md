# Split Memory Server Architecture

This document describes the current production topology and lifecycle ownership for the shared memory MCP runtime.

## Topology

`npm start` launches `start.js`, which selects one memory topology:

- `split` — the default: retrieval, bridge, dream and management services;
- `monolithic` / `all` — the legacy compatibility service.

The split endpoints are:

| Service | MCP port | Metrics port | Responsibility |
| --- | ---: | ---: | --- |
| `memory-retrieval` | 9338 | 9438 | Read-only status, bootstrap and retrieval |
| `memory-bridge` | 9339 | 9439 | Claude Mem, OpenClaw and derived-layer bridges |
| `memory-dream` | 9340 | 9440 | Embedding rebuild and memory consolidation |
| `memory-mgmt` | 9341 | 9441 | Canonical writes, runtime selection and KG management |

`AI_MEMORY_BASE_PORT` shifts all ports together. `shared-mcp/port-registry.js` validates the derived range before any listener is opened.

## Production lifecycle owner

There is exactly one production lifecycle chain:

1. `start.js` selects services, validates ports and adopts only matching healthy services.
2. For each service it launches `shared-mcp/singleton-stdio-mcp-proxy.mjs`.
3. The proxy owns the public HTTP listener and one stdio child process.
4. `shared-mcp/proto/child-process.mjs` owns child spawn and teardown.
5. `shared-mcp/proto/restart.mjs` owns crash restart policy and circuit-breaking.
6. The PowerShell start/status/stop wrappers operate on the same proxy processes and endpoints.

The former `shared-mcp/mcp-process-manager.js` was never called by the production launcher. It and its isolated tests were removed because retaining a second, unused lifecycle implementation created misleading behavior and configuration drift.

## Port ownership and adoption

Before starting a proxy, `start.js` checks whether the requested port is occupied. An occupied port is adopted only when `/healthz` returns:

- HTTP success;
- `ok: true`;
- the expected `serverId`.

Unknown or unhealthy occupants cause startup to fail. The launcher does not print an endpoint as active unless it was started or a matching healthy service was adopted.

## Proxy responsibilities

`singleton-stdio-mcp-proxy.mjs` owns:

- the loopback HTTP MCP endpoint;
- Host-header validation;
- JSON body and inflight limits;
- request ID translation;
- stdio child initialization;
- child-response correlation and timeouts;
- restart scheduling after unexpected child failure;
- graceful teardown on `SIGINT` and `SIGTERM`.

The proxy health endpoint reports healthy only when the stdio child is initialized and alive.

## Memory service internals

Every memory process runs `shared-mcp/omni-memory-server.js`. The entrypoint assembles shared helpers and registers only the tool subset selected by `AI_MEMORY_SERVER_MODE`:

- retrieval tools from `RETRIEVAL_TOOLS`;
- bridge tools from `BRIDGE_TOOLS`;
- dream tools from `DREAM_TOOLS`;
- management tools from `MGMT_TOOLS`.

`memory_write` belongs to management and is not exposed by the read-only retrieval endpoint.

The current processes still construct shared handler dependencies before filtering the exposed subset. Further module-level lazy loading may reduce startup cost, but it is not a second lifecycle system.

## Failure behavior

- Invalid topology or base-port configuration fails before spawn.
- An unknown process occupying a required port fails startup.
- Child request timeout rejects only the affected request.
- Unexpected child exit schedules a bounded restart.
- Restart limits open the proxy circuit rather than spawning duplicate children.
- Shutdown closes the HTTP server and terminates the child process tree.
- Docker health uses `scripts/health-check-core.mjs` to verify all core services.

## Source-of-truth files

- service and port registry: `shared-mcp/port-registry.js`
- tool membership: `shared-mcp/tool-registry.js`
- public service metadata: `shared-mcp/manifest.json`
- launcher: `start.js`
- HTTP proxy: `shared-mcp/singleton-stdio-mcp-proxy.mjs`
- process primitives: `shared-mcp/proto/child-process.mjs`
- restart policy: `shared-mcp/proto/restart.mjs`
- aggregate health check: `scripts/health-check-core.mjs`

CI checks the split tool boundary, manifest/port consistency, cross-platform startup and Docker health behavior.
