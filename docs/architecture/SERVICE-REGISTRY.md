# Service Registry

`shared-mcp/services.registry.json` is the canonical machine-readable source for shared MCP service metadata.

It owns:

- service IDs and display names;
- shared, optional or isolated classification;
- base-port offsets and metrics offsets;
- split versus monolithic topology membership;
- core runtime commands, arguments and environment;
- probe metadata and restart-policy metadata;
- pinned optional fallback commands;
- client-facing manifest metadata.

## Consumers

`shared-mcp/port-registry.js` reads the registry directly at runtime and derives:

- `MCP_SERVERS`;
- split MCP and metrics port maps;
- critical client-facing ports;
- base-port validation limits.

`scripts/generate-service-artifacts.mjs` projects the public fields into `shared-mcp/manifest.json`.

Generate the manifest after editing the registry:

```bash
npm run generate:services
```

Check without changing files:

```bash
npm run check:services
```

CI runs the check and fails when the public manifest is semantically stale. Unit tests also validate Docker/Compose exposure, split endpoint documentation, pinned commands and topology mutual exclusion.

## Change workflow

1. Edit `services.registry.json` only for service identity, ports, commands or topology.
2. Run `npm run generate:services`.
3. Update implementation-specific code only when the service behavior itself changed.
4. Run `npm test`, Docker validation and platform smoke tests.
5. Submit the registry and generated manifest in the same pull request.

Do not hand-edit runtime ports in `port-registry.js`. Do not introduce `@latest` into production fallback commands.
