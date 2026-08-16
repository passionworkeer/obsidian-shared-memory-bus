/**
 * skills/user-portrait/lib/schema.js
 * ----------------------------------
 * Unified message schema + privacy redaction for the user-portrait skill.
 *
 * Unified record (one line of <store>/portrait/messages.jsonl):
 *   {
 *     "v": 1,
 *     "source": "claude-code",        // adapter id
 *     "ts": 1723766400000,            // ms epoch, null when unknown
 *     "text": "...",                  // user-side message, redacted
 *     "project": "repo-name",         // optional working context
 *     "session": "abc123",            // optional session id
 *     "peer": "张三",                  // chat-import only: chat counterpart
 *     "from_user": true               // chat-import: definitely typed by the
 *   }                                 // human (vs. contact-sent)
 *
 * Redaction is ON by default and strips credential-shaped substrings
 * (API keys, tokens, bearer headers, private keys, long hex blobs) plus —
 * in "strict" mode — emails and phone numbers. Raw material never leaves
 * the machine; this is defense-in-depth for derived artifacts that agents
 * later quote from.
 */

export const SCHEMA_VERSION = 1;

/**
 * Ordered [RegExp, replacement] rules. Longest/most-specific first.
 * Keys use a compact alphabet so redacted text stays short.
 */
const SECRET_RULES = [
  // OpenAI-style keys / GitHub tokens / Slack / Anthropic / generic sk-
  [/\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-ant-[A-Za-z0-9_-]{16,})/g, "[REDACTED:key]"],
  // AWS access keys
  [/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED:awskey]"],
  // Bearer / token / api-key headers (any scheme)
  [/\b(bearer\s+|token\s*[:=]\s*|api[-_]?key\s*[:=]\s*|authorization\s*[:=]\s*)(["'`]?)[A-Za-z0-9._+/=-]{16,}\2/gi, "$1[REDACTED:token]"],
  // Private key blocks (multiline-capable)
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED:pem]"],
  // Long hex blobs (64+ chars: sha, secrets)
  [/\b[0-9a-fA-F]{64,}\b/g, "[REDACTED:hex]"],
  // Connection strings with embedded credentials
  [/\b([a-z][a-z0-9+.-]*:\/\/)([^\s:@/"'){]{1,64}):([^\s@/"'){]{1,64})@/gi, "$1[REDACTED:userpass]@"],
];

const STRICT_EXTRA_RULES = [
  [/\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, "[REDACTED:email]"],
  [/(?<!\d)(?:\+?\d{1,3}[\s-]?)?(?:1[3-9]\d{9}|\d{3,4}[\s-]\d{7,8})(?!\d)/g, "[REDACTED:phone]"],
];

/**
 * Redact credential-shaped content in place (returns new string).
 * mode: "default" (secrets) | "strict" (secrets + emails + phones) | "off"
 */
export function redact(text, mode = "default") {
  if (mode === "off" || !text) return text;
  let out = String(text);
  for (const [re, rep] of SECRET_RULES) out = out.replace(re, rep);
  if (mode === "strict") {
    for (const [re, rep] of STRICT_EXTRA_RULES) out = out.replace(re, rep);
  }
  return out;
}

/**
 * Build a normalized unified record. Invalid records (no usable text after
 * cleaning) return null so collectors can skip them cheaply.
 */
export function buildMessage({ source, ts, text, project, session, peer, from_user }, { redactMode = "default", maxChars = 4000 } = {}) {
  let cleaned = String(text || "").trim();
  // Drop agent-side noise that pollutes "user messages": command-metas,
  // tool-result wrappers, bare XML-ish control prompts.
  if (!cleaned) return null;
  if (/^(<system-reminder>|<command-name>|Caveat:|This session is being continued)/i.test(cleaned)) return null;
  if (/^<user_query>/i.test(cleaned)) {
    cleaned = cleaned.replace(/^<user_query>/i, "").replace(/<\/user_query>$/i, "").trim();
  }
  if (!cleaned) return null;
  // Interactive command echo (Claude Code): keep the payload after the slash
  // command name, drop the arguments blob when it embeds giant JSON.
  if (cleaned.length > maxChars) cleaned = cleaned.slice(0, maxChars) + "…";
  cleaned = redact(cleaned, redactMode);
  if (!cleaned.trim()) return null;

  return {
    v: SCHEMA_VERSION,
    source: String(source || "unknown"),
    ts: Number.isFinite(ts) ? ts : null,
    text: cleaned,
    ...(project ? { project: String(project).slice(0, 120) } : {}),
    ...(session ? { session: String(session).slice(0, 64) } : {}),
    ...(peer ? { peer: String(peer).slice(0, 64) } : {}),
    ...(from_user === true || from_user === false ? { from_user } : {}),
  };
}
