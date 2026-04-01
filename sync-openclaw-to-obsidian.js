// sync-openclaw-to-obsidian.js
// 解析 OpenClaw session JSONL，写入 structured/openclaw.jsonl 和 inbox/openclaw.md
const fs = require('fs');
const path = require('path');

const USER_HOME = process.env.USERPROFILE || process.env.HOME || '';
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || path.join(USER_HOME, '.openclaw');
const VAULT_ROOT =
  process.env.AI_MEMORY_OBSIDIAN_VAULT ||
  process.env.OBSIDIAN_VAULT_ROOT ||
  path.join(USER_HOME, 'Documents', 'Obsidian Vault');
const SESSION_DIR = process.env.OPENCLAW_SESSION_DIR || path.join(OPENCLAW_HOME, 'agents', 'main', 'sessions');
const VB = path.join(VAULT_ROOT, '00-System', 'ai-memory');
const STRUCTURED_FILE = VB + '/structured/openclaw.jsonl';
const INBOX_FILE = VB + '/inbox/openclaw.md';

function getRecentSessions(n = 20) {
  const files = fs.readdirSync(SESSION_DIR)
    .filter(f => f.endsWith('.jsonl') && !f.includes('.deleted.') && !f.includes('.reset.'))
    .map(f => ({
      name: f,
      path: path.join(SESSION_DIR, f),
      mtime: fs.statSync(path.join(SESSION_DIR, f)).mtime
    }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, n);
  return files;
}

function parseSession(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  const events = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch (err) {
      console.error(`[sync-openclaw] JSON parse error on line (skipping): ${err.message}`);
      continue;
    }
  }
  return events;
}

function extractStructuredSession(events, fileName) {
  const sessionMeta = events.find(e => e.type === 'session');
  const modelChange = events.find(e => e.type === 'model_change');
  const messages = events.filter(e => e.type === 'message');

  // Extract user prompts and assistant summaries
  const interactions = [];
  let lastRole = null;
  for (const msg of messages) {
    if (msg.message?.role === 'user') {
      const text = extractText(msg.message.content);
      if (text && text.length > 20) {
        // Truncate long cron prompts
        const shortText = text.length > 300 ? text.substring(0, 300) + '...' : text;
        // Extract agent type from cron tags
        let agent = 'unknown';
        const cronMatch = text.match(/\[cron:([^\]]+)\s+([^\]]+)/);
        if (cronMatch) {
          agent = cronMatch[2]; // e.g. "情报虾", "开发虾"
        }
        interactions.push({
          role: 'user',
          text: shortText,
          agent,
          timestamp: msg.timestamp
        });
      }
    }
    lastRole = msg.message?.role;
  }

  if (interactions.length === 0) return null;

  const sessionId = sessionMeta?.id || fileName.replace('.jsonl', '');
  const startTime = sessionMeta?.timestamp || events[0]?.timestamp || null;
  const model = modelChange ? `${modelChange.provider}/${modelChange.modelId}` : 'unknown';
  const cwd = sessionMeta?.cwd || '';

  return interactions.map((interaction, i) => ({
    id: `${sessionId}-${i}`,
    t: startTime,
    tool: 'openclaw',
    session: sessionId,
    type: 'cron-task',
    project: cwd.split(/[/\\]/).pop() || 'workspace',
    agent: interaction.agent,
    title: interaction.text.split('\n')[0].substring(0, 100),
    content: interaction.text,
    facts: [],
    concepts: [interaction.agent],
    files_read: [],
    files_modified: [],
    source: 'openclaw-session'
  }));
}

function extractText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(c => {
      if (typeof c === 'string') return c;
      if (c?.type === 'text') return c.text || '';
      if (c?.type === 'tool_use') return `[tool: ${c.name || 'unknown'}]`;
      return '';
    }).filter(Boolean).join(' ');
  }
  return '';
}

// Load existing entry IDs for deduplication
const existingIds = new Set();
if (fs.existsSync(STRUCTURED_FILE)) {
  for (const line of fs.readFileSync(STRUCTURED_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      existingIds.add(JSON.parse(line).id);
    } catch (err) {
      console.error(`[sync-openclaw] JSON parse error in deduplication pass (skipping line): ${err.message}`);
    }
  }
}

const newEntries = [];
const recentSessions = getRecentSessions(20);
console.log(`Found ${recentSessions.length} recent sessions`);

for (const session of recentSessions) {
  try {
    const events = parseSession(session.path);
    const entries = extractStructuredSession(events, session.name);
    if (!entries) continue;
    for (const entry of entries) {
      if (existingIds.has(entry.id)) continue;
      newEntries.push(entry);
      existingIds.add(entry.id);
    }
    console.log(`  ${session.name}: ${events.length} events, ${entries.length} entries`);
  } catch (e) {
    console.log(`  Error ${session.name}: ${e.message}`);
  }
}

// If new entries, append to structured FIRST
if (newEntries.length > 0) {
  const jsonlLines = newEntries.map(e => JSON.stringify(e)).join('\n');
  fs.appendFileSync(STRUCTURED_FILE, jsonlLines + '\n', 'utf8');
  console.log(`Added ${newEntries.length} entries to structured/openclaw.jsonl`);
} else {
  console.log('No new entries.');
}

// Always rebuild inbox from structured file (filter noise, newest 20)
const NOISE_PATTERNS = [
  /^Sender\s*\(/i,
  /^System:/i,
  /^Subagent Context/i,
  /^\[Subagent Context\]/i,
  /^Exec completed/i,
  /^Exec failed/i,
  /^A new session was started/i,
  /^\[Tue/i,
  /^\[Wed/i,
  /^\[Mon/i,
  /^\[Thu/i,
  /^\[Fri/i,
  /^\[Sat/i,
  /^\[Sun/i,
  /^Run your Session Startup/i,
];
function isNoise(text) {
  const t = text.trim();
  if (NOISE_PATTERNS.some(p => p.test(t))) return true;
  // Also filter if it contains Subagent Context or Sender metadata in body
  if (/\bSubagent Context\b/i.test(t) && /^\[.{3,20}\]/.test(t)) return true;
  if (/^Sender\s*\(/.test(t)) return true;
  return false;
}

const allStructured = [];
if (fs.existsSync(STRUCTURED_FILE)) {
  for (const line of fs.readFileSync(STRUCTURED_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { allStructured.push(JSON.parse(line)); } catch (err) {
      console.error(`[sync-openclaw] JSON parse error in structured rebuild (skipping line): ${err.message}`);
    }
  }
}
const cleanEntries = allStructured.filter(e => !isNoise(e.content));
const last20 = cleanEntries.slice(-20).reverse();
const inboxLines = last20.map(e => {
  const time = e.t ? e.t.replace('T', ' ').replace('Z', '').substring(0, 19) : 'unknown';
  const agent = e.agent && e.agent !== 'unknown' ? `[${e.agent}] ` : '';
  return `- ${time} ${agent}${e.title}`;
}).join('\n');

let existingInbox = '';
if (fs.existsSync(INBOX_FILE)) {
  existingInbox = fs.readFileSync(INBOX_FILE, 'utf8');
  const lines = existingInbox.split('\n');
  const headerLines = [];
  const restStart = lines.findIndex(l => l.startsWith('- '));
  if (restStart >= 0) {
    for (let i = 0; i < restStart; i++) headerLines.push(lines[i]);
  } else {
    headerLines.push(...lines.slice(0, Math.min(3, lines.length)));
  }
  existingInbox = headerLines.join('\n');
  if (!existingInbox.endsWith('\n')) existingInbox += '\n';
}
fs.writeFileSync(INBOX_FILE, (existingInbox + inboxLines + '\n').replace(/^\uFEFF/, ''), 'utf8');
console.log(`Updated inbox/openclaw.md with ${Math.min(20, cleanEntries.length)} entries`);

console.log('\n=== OpenClaw sync complete ===');
console.log('Total structured entries:', allStructured.length);
