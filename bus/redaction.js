// Best-effort secret and personal-data redaction before text leaves the machine.
// The local structured store remains the source of truth; this helper protects
// network-bound embedding payloads and intentionally preserves array shape.

const REDACTED = "[REDACTED]";

const PATTERNS = [
  { regex: /\bsk-[A-Za-z0-9_-]{16,}\b/g, replacement: REDACTED },
  { regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replacement: REDACTED },
  { regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replacement: REDACTED },
  {
    regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{10,}/gi,
    replacement: `Bearer ${REDACTED}`,
  },
  {
    regex: /\b(api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd)\s*[:=]\s*(["']?)[^\s"',;]{6,}\2/gi,
    replacement: (_match, key) => `${key}=${REDACTED}`,
  },
  {
    regex: /([?&](?:api[_-]?key|access[_-]?token|token|secret|password)=)[^&#\s]+/gi,
    replacement: `$1${REDACTED}`,
  },
  {
    regex: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    replacement: "[REDACTED_EMAIL]",
  },
  {
    regex: /\bhttps?:\/\/[^\s/@:]+:[^\s/@]+@/gi,
    replacement: (match) => match.replace(/\/\/[^@]+@/, `//${REDACTED}@`),
  },
];

export function isRedactionEnabled(env = process.env) {
  const raw = String(env.AI_MEMORY_REDACTION_ENABLED ?? "true").trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(raw);
}

export function redactSensitiveText(value, env = process.env) {
  const input = String(value ?? "");
  if (!input || !isRedactionEnabled(env)) return input;

  let output = input;
  for (const { regex, replacement } of PATTERNS) {
    regex.lastIndex = 0;
    output = output.replace(regex, replacement);
  }
  return output;
}

export function redactRemoteEmbeddingTexts(texts, env = process.env) {
  if (!Array.isArray(texts)) {
    throw new TypeError("embedding texts must be an array");
  }
  return texts.map((text) => redactSensitiveText(text, env));
}

export { REDACTED };
