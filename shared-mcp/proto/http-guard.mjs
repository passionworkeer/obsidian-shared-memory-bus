const LOOPBACK_HOST_PATTERN = /^(?:127\.0\.0\.1|\[::1\]|localhost)(?::\d+)?$/i;

function normalizeHeader(value) {
  if (Array.isArray(value)) return String(value[0] || "").trim();
  return String(value || "").trim();
}

export function isAllowedLoopbackHost(hostHeader) {
  return LOOPBACK_HOST_PATTERN.test(normalizeHeader(hostHeader));
}

export function isAllowedLocalOrigin(originHeader, expectedHostHeader) {
  const origin = normalizeHeader(originHeader);
  if (!origin) return true;
  if (origin.toLowerCase() === "null") return false;

  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }

  if (parsed.protocol !== "http:") return false;
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    return false;
  }
  if (!isAllowedLoopbackHost(parsed.host)) return false;

  const expectedHost = normalizeHeader(expectedHostHeader).toLowerCase();
  return parsed.host.toLowerCase() === expectedHost;
}

/**
 * Accept native/desktop clients that do not send browser fetch metadata, while
 * rejecting DNS rebinding and cross-origin browser requests. A browser request
 * with Origin must be same-origin with the exact loopback Host. Sec-Fetch-Site
 * values other than same-origin/none are denied even when Origin is missing.
 */
export function isAllowedLocalHttpRequest(headers = {}) {
  const host = normalizeHeader(headers.host);
  if (!isAllowedLoopbackHost(host)) return false;

  const fetchSite = normalizeHeader(headers["sec-fetch-site"]).toLowerCase();
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    return false;
  }

  return isAllowedLocalOrigin(headers.origin, host);
}
