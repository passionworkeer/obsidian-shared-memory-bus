/**
 * Chat import: user-exported WeChat / QQ chat history.
 *
 * Never auto-scans — the user explicitly runs `import-chat` on files they
 * exported themselves (guide in skills/user-portrait/README.md). Accepts the
 * common export shapes:
 *
 *   .csv  — MemoTrace/WeChatMsg, echotrace, generic (header fuzzy-matched)
 *   .txt  — WeChatMsg txt export / QQ merged-forward blocks:
 *             "2026-01-01 12:00:33 张三\n内容" or "张三 2026/1/1 12:00:33"
 *   .json — array (or {messages|data:[…]}) of {time|ts|createTime,
 *           content|text|msg, isSend|sender|from}
 *   .html — best-effort: strip tags, then apply the txt block parser
 *
 * Returns { format, messages: [{ts, text, from_user?, peer?}], errors }.
 * Self-sent detection: IsSend==1 / sender containing 我|self|me — everything
 * else keeps from_user undefined (contact-sent context, counted separately).
 */

import fs from "node:fs";
import path from "node:path";
import { toMs } from "../util.js";

const TIME_HEADERS = ["消息时间", "时间", "日期时间", "strtime", "时间戳", "timestamp", "createtime", "create_time", "datetime", "time", "date"];
const SENDER_HEADERS = ["发送者", "发送人", "说话人", "发言人", "issend", "is_send", "issender", "speaker", "sender", "talker", "from"];
const CONTENT_HEADERS = ["消息内容", "内容", "strcontent", "content", "msg", "text", "message", "消息"];
const PEER_HEADERS = ["聊天对象", "对方", "联系人", "群名", "会话", "peer", "talker", "username", "nickname", "昵称", "chat"];

function findHeader(headers, candidates) {
  for (const cand of candidates) {
    const hit = headers.findIndex((h) => String(h).toLowerCase().trim() === cand.toLowerCase());
    if (hit !== -1) return hit;
  }
  for (const cand of candidates) {
    const hit = headers.findIndex((h) => String(h).toLowerCase().includes(cand.toLowerCase()));
    if (hit !== -1) return hit;
  }
  return -1;
}

/** Minimal CSV row splitter (handles quotes, escaped quotes, CRLF). */
function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function parseSelfSender(raw) {
  if (raw == null) return undefined;
  const s = String(raw).trim().toLowerCase();
  if (s === "1" || s === "true" || s === "我" || s === "self" || s === "me" || s === "本人") return true;
  if (s === "0" || s === "false" || s === "") return false;
  if (s.includes("我") || s.includes("self")) return true;
  return undefined;
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return { format: "csv", messages: [], errors: ["csv: no data rows"] };
  const headers = parseCsvLine(lines[0]);
  const tIdx = findHeader(headers, TIME_HEADERS);
  const sIdx = findHeader(headers, SENDER_HEADERS);
  const cIdx = findHeader(headers, CONTENT_HEADERS);
  const pIdx = findHeader(headers, PEER_HEADERS);
  if (cIdx === -1 || tIdx === -1) {
    return { format: "csv", messages: [], errors: [`csv: no time/content column (headers: ${headers.join(",")})`] };
  }
  // A numeric IsSend/IsSender column beats a sender-name column: contact
  // names can't be resolved to "self" without knowing the user's nickname.
  const isSendIdx = headers.findIndex((h) => /^(is[_\s]?send(er)?|issend(er)?)$/i.test(String(h).trim()));
  const messages = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const content = cols[cIdx];
    if (!content) continue;
    let from_user;
    if (isSendIdx !== -1) from_user = parseSelfSender(cols[isSendIdx]);
    else if (sIdx !== -1) from_user = parseSelfSender(cols[sIdx]);
    messages.push({
      ts: toMs(cols[tIdx]) ?? parseCnDate(cols[tIdx]),
      text: content,
      from_user,
      peer: pIdx !== -1 ? cols[pIdx] || undefined : undefined,
    });
  }
  return { format: "csv", messages, errors: [] };
}

const HEADER_TS = /^(\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}[日]?\s+\d{1,2}:\d{2}(?::\d{2})?)/;
const HEADER_TS_NAME = /^(\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}[日]?\s+\d{1,2}:\d{2}(?::\d{2})?)\s+(.{1,40})$/;
const HEADER_NAME_TS = /^(.{1,40}?)\s+(\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}[日]?\s+\d{1,2}:\d{2}(?::\d{2})?)$/;

function parseCnDate(s) {
  if (!s) return null;
  const m = String(s).match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})[日T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime();
}

function parseTxtBlocks(lines) {
  const messages = [];
  let cur = null;
  const flush = () => {
    if (cur && cur.text.trim()) {
      cur.text = cur.text.trim();
      messages.push(cur);
    }
    cur = null;
  };
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const m1 = line.match(HEADER_TS_NAME);
    const m2 = m1 ? null : line.match(HEADER_NAME_TS);
    if (m1 && HEADER_TS.test(m1[1])) {
      flush();
      cur = { ts: parseCnDate(m1[1]), text: "", from_user: parseSelfSender(m1[2]), peer: undefined };
    } else if (m2 && HEADER_TS.test(m2[2])) {
      flush();
      cur = { ts: parseCnDate(m2[2]), text: "", from_user: parseSelfSender(m2[1]), peer: undefined };
    } else if (cur) {
      if (line.trim() === "") flush();
      else cur.text += line + "\n";
    }
  }
  flush();
  return messages;
}

function parseTxt(text) {
  const messages = parseTxtBlocks(text.split(/\r?\n/));
  return { format: "txt", messages, errors: messages.length ? [] : ["txt: no timestamped blocks recognized"] };
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]{2,}/g, " ");
}

function parseHtml(text) {
  const messages = parseTxtBlocks(stripHtml(text).split(/\r?\n/));
  return { format: "html", messages, errors: messages.length ? [] : ["html: no chat blocks recognized after tag strip"] };
}

function parseJsonExport(text, file) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { format: "json", messages: [], errors: [`json: ${err.message}`] };
  }
  const arr = Array.isArray(data) ? data : data && (Array.isArray(data.messages) ? data.messages : Array.isArray(data.data) ? data.data : Array.isArray(data.msg_list) ? data.msg_list : null);
  if (!arr) return { format: "json", messages: [], errors: ["json: no top-level array / messages[] / data[]"] };
  const messages = [];
  for (const m of arr) {
    if (!m || typeof m !== "object") continue;
    const content = m.content ?? m.text ?? m.msg ?? m.StrContent ?? m.message;
    if (typeof content !== "string" || !content.trim()) continue;
    const ts = toMs(m.time ?? m.ts ?? m.createTime ?? m.timestamp ?? m.CreateTime) ?? parseCnDate(m.time ?? m.createTime ?? "");
    const sender = m.isSend ?? m.isSend ?? m.IsSend ?? m.sender ?? m.from ?? m.speaker ?? m.talker;
    messages.push({ ts, text: content, from_user: parseSelfSender(sender), peer: m.peer ?? m.chat ?? m.username ?? undefined });
  }
  return { format: "json", messages, errors: messages.length ? [] : [`json: 0 usable records in ${path.basename(file)}`] };
}

/**
 * Parse one exported chat file.
 * @param {string} file absolute path
 * @returns {{format: string, messages: object[], errors: string[]}}
 */
export function parseChatFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch (err) {
    return { format: "?", messages: [], errors: [`${file}: ${err.message}`] };
  }
  const ext = path.extname(file).toLowerCase();
  if (ext === ".csv") return parseCsv(text);
  if (ext === ".txt" || ext === ".log") return parseTxt(text);
  if (ext === ".json") return parseJsonExport(text, file);
  if (ext === ".html" || ext === ".htm") return parseHtml(text);
  return { format: "?", messages: [], errors: [`unsupported extension: ${ext} (use .csv/.txt/.json/.html)`] };
}

/** Parse a file or every supported file under a directory. */
export function parseChatPath(target) {
  let files;
  try {
    const stat = fs.statSync(target);
    if (stat.isDirectory()) {
      files = fs
        .readdirSync(target)
        .filter((f) => /\.(csv|txt|log|json|html?)$/i.test(f))
        .map((f) => path.join(target, f));
    } else {
      files = [target];
    }
  } catch (err) {
    return { format: "?", messages: [], errors: [`${target}: ${err.message}`] };
  }
  const all = { format: "multi", messages: [], errors: [] };
  for (const f of files) {
    const r = parseChatFile(f);
    for (const m of r.messages) all.messages.push({ ...m, _file: path.basename(f) });
    all.errors.push(...r.errors);
  }
  return all;
}
