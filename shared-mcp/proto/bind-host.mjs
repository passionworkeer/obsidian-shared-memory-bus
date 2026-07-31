const ALLOWED_BIND_HOSTS = new Set(['127.0.0.1', '0.0.0.0', '::1']);

export function resolveProxyBindHost(env = process.env) {
  const configured = String(env.AI_MEMORY_BIND_HOST || '127.0.0.1').trim();
  if (!ALLOWED_BIND_HOSTS.has(configured)) {
    throw new Error(
      `Unsupported AI_MEMORY_BIND_HOST: ${configured}. Allowed: ${[...ALLOWED_BIND_HOSTS].join(', ')}`,
    );
  }
  return configured;
}
