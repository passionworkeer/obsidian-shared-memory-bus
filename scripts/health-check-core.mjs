#!/usr/bin/env node

const basePort = Number.parseInt(process.env.AI_MEMORY_BASE_PORT || "9330", 10);
const host = process.env.AI_MEMORY_HEALTH_HOST || "127.0.0.1";
const services = [
  { id: "fetch", offset: 2 },
  { id: "time", offset: 3 },
  { id: "memory-retrieval", offset: 8 },
  { id: "memory-bridge", offset: 9 },
  { id: "memory-dream", offset: 10 },
  { id: "memory-mgmt", offset: 11 },
];

async function check(service) {
  const port = basePort + service.offset;
  const url = `http://${host}:${port}/healthz`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
    const payload = await response.json();
    const ok = response.ok && payload?.ok === true && payload?.serverId === service.id;
    return { ...service, port, ok, status: response.status, payload };
  } catch (error) {
    return {
      ...service,
      port,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const results = await Promise.all(services.map(check));
const failures = results.filter((result) => !result.ok);

if (failures.length > 0) {
  process.stderr.write(`${JSON.stringify({ ok: false, failures, results }, null, 2)}\n`);
  process.exit(1);
}

process.stdout.write(`${JSON.stringify({ ok: true, services: results.map(({ id, port }) => ({ id, port })) })}\n`);
