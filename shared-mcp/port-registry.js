/**
 * Runtime port helpers derived from services.registry.json.
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const registry = JSON.parse(
  fs.readFileSync(fileURLToPath(new URL('./services.registry.json', import.meta.url)), 'utf8'),
);

export const SERVICE_REGISTRY = Object.freeze(registry);
export const DEFAULT_BASE_PORT = registry.defaults.basePort;
export const DEFAULT_METRICS_PORT_OFFSET = 100;

const runtimeServices = registry.servers.filter((service) => service.core && service.runtimeCommand);

export const MCP_SERVERS = Object.freeze(runtimeServices.map((service) => ({
  id: service.id,
  port: DEFAULT_BASE_PORT + service.portOffset,
  ...(Number.isInteger(service.metricsOffset)
    ? { metricsPort: DEFAULT_BASE_PORT + service.metricsOffset }
    : {}),
  command: service.runtimeCommand,
  args: [...service.runtimeArgs],
  ...(service.runtimeEnv ? { env: { ...service.runtimeEnv } } : {}),
  ...(service.legacy ? { legacy: true } : {}),
  ...(service.topology === 'monolithic' ? { onlyInMode: 'monolithic' } : {}),
})));

function buildMemoryPortMap(field) {
  return Object.freeze(Object.fromEntries(
    registry.servers
      .filter((service) => service.topology === 'split' && Number.isInteger(service[field]))
      .map((service) => [
        service.id.replace('memory-', ''),
        DEFAULT_BASE_PORT + service[field],
      ]),
  ));
}

export const SPLIT_MEMORY_SERVER_PORTS = buildMemoryPortMap('portOffset');
export const SPLIT_MEMORY_METRICS_PORTS = buildMemoryPortMap('metricsOffset');

export const CRITICAL_PORTS = Object.freeze(registry.servers
  .filter((service) => service.critical && Number.isInteger(service.portOffset))
  .map((service) => DEFAULT_BASE_PORT + service.portOffset));

const MAX_PORT_OFFSET = Math.max(
  ...registry.servers.flatMap((service) => [service.portOffset, service.metricsOffset]
    .filter(Number.isInteger)),
);

function validateBasePort(value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`invalid AI_MEMORY_BASE_PORT: ${value}`);
  }
  if (value + MAX_PORT_OFFSET > 65535) {
    throw new Error(
      `AI_MEMORY_BASE_PORT ${value} is too high; derived ports extend to ${value + MAX_PORT_OFFSET}`,
    );
  }
  return value;
}

function validateDerivedPort(value, label) {
  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    throw new Error(`invalid ${label} port: ${value}`);
  }
  return value;
}

export function resolveBasePort(env = process.env) {
  const raw = String(env.AI_MEMORY_BASE_PORT || '').trim();
  if (!raw) {
    return DEFAULT_BASE_PORT;
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(`invalid AI_MEMORY_BASE_PORT: ${raw}`);
  }
  return validateBasePort(Number(raw));
}

export function getServerPort(server, basePort = resolveBasePort()) {
  validateBasePort(basePort);
  return validateDerivedPort(
    basePort + (server.port - DEFAULT_BASE_PORT),
    `${server?.id || 'server'} MCP`,
  );
}

export function getServerMetricsPort(server, basePort = resolveBasePort()) {
  if (!Number.isFinite(server?.metricsPort)) return null;
  validateBasePort(basePort);
  return validateDerivedPort(
    basePort + (server.metricsPort - DEFAULT_BASE_PORT),
    `${server?.id || 'server'} metrics`,
  );
}
