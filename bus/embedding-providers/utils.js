// Small helpers shared across embedding providers.

export function normalizeString(value) {
  return String(value || "").trim();
}

export function getProviderHost(baseUrl) {
  if (!baseUrl) {
    return "";
  }
  try {
    return new URL(baseUrl).host || "";
  } catch {
    return "";
  }
}
