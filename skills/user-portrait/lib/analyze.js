/**
 * skills/user-portrait/lib/analyze.js
 * ----------------------------------
 * Streams messages.jsonl into stats.json — everything computable without an
 * LLM: coverage, timeline, hour/weekday rhythms, keywords (reusing the
 * bus's CJK-aware tokenizer from bus/bm25.js), project footprint, language
 * mix, and habit indices. The qualitative half of the profile is filled by
 * the invoking agent on top of these facts.
 */

import fs from "node:fs";
import path from "node:path";
import { streamJsonl, dayKey, cjkRatio } from "./util.js";
import { tokenize } from "../../../bus/bm25.js";

// Words that describe interaction plumbing, not the person.
// Second line: paste-marker tokens injected by Claude Code attachment
// placeholders ("…Desktop\\foo.py 1024 lines pasted"), path fragments and
// pure glue tokens.
const STOPWORDS = new Set(
  (
    "the a an and or of to in on for with is are was were be been this that it its as at by from " +
    "i me my we you your he she they them our us if then than so not no do does did can could would should " +
    "will just about into over under out up down off more most other some such only own same too very " +
    "的 了 吗 呢 吧 啊 呀 哦 嗯 哈哈 是 我 你 他 她 它 们 在 有 和 就 都 不 这 那 个 人 说 要 去 会 着 也 没 看 很 " +
    "自己 什么 怎么 因为 所以 但是 而且 然后 还是 已经 现在 可能 觉得 需要 可以 一个 一下 这个 那个 用 让 给 " +
    "help please thanks thank hi hello ok okay yes no wait 谢谢 你好 请问 帮 忙 等等 直接 或者 以及 但是 关于 " +
    "问题 看看 不是 里面 就是 继续 还有 没有 了吗 是不 我的 全部 这些 面的 有没 你看 在的 个项 的文 其他 么的 " +
    "pasted lines text desktop users home app data local tmp temp path file files folder dir directory " +
    "window windows chrome png jpg jpeg txt log http https www com net org content paste attach cn"
  ).split(/\s+/).filter(Boolean)
);
const TRIVIAL = new Set(["js", "ts", "id", "ok", "np", "ng", "vs", "ci", "cd", "db", "ui", "ux", "md", "py", "ex", "de", "la"]);

function topN(counter, n) {
  return [...counter.entries()]
    .filter(([t, c]) => c > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([t, c]) => ({ t, n: c }));
}

/**
 * @param {string} outDir portrait dir containing messages.jsonl
 * @returns {Promise<{statsFile: string, stats: object}>}
 */
export async function analyzeMessages(outDir) {
  const messagesFile = path.join(outDir, "messages.jsonl");

  const stats = {
    generated_at: new Date().toISOString(),
    total: 0,
    with_ts: 0,
    first_ts: null,
    last_ts: null,
    sources: {},
    days: {},
    months: {},
    hours: new Array(24).fill(0),
    weekdays: new Array(7).fill(0), // 0=Sun
    latin_terms: {},
    cjk_terms: {},
    projects: {},
    language: { cjk_msg_count: 0, cjk_ratio_sum: 0 },
    activity: {
      active_days: 0,
      night_count: 0,      // 0-6h messages
      weekend_count: 0,
      question_count: 0,
      len_sum: 0,
    },
    chat: { total: 0, from_user: 0, with_peer: 0, peers: {} },
    samples: { recent: [] },
  };

  if (!fs.existsSync(messagesFile)) {
    throw new Error(`messages.jsonl not found under ${outDir} — run collect first`);
  }

  const recentRing = [];

  for await (const m of streamJsonl(messagesFile)) {
    if (!m || !m.text) continue;
    stats.total += 1;

    const src = (stats.sources[m.source] ||= { count: 0, first: null, last: null });
    src.count += 1;

    if (m.ts) {
      stats.with_ts += 1;
      if (!stats.first_ts || m.ts < stats.first_ts) stats.first_ts = m.ts;
      if (!stats.last_ts || m.ts > stats.last_ts) stats.last_ts = m.ts;
      const d = new Date(m.ts);
      const day = dayKey(m.ts);
      if (day) {
        stats.days[day] = (stats.days[day] || 0) + 1;
        const month = day.slice(0, 7);
        stats.months[month] = (stats.months[month] || 0) + 1;
        stats.hours[d.getHours()] += 1;
        stats.weekdays[d.getDay()] += 1;
        if (d.getHours() < 6) stats.activity.night_count += 1;
        if (d.getDay() === 0 || d.getDay() === 6) stats.activity.weekend_count += 1;
        recentRing.push({ ts: m.ts, text: m.text.slice(0, 160) });
        if (recentRing.length > 12) recentRing.shift();
      }
    }

    if (m.project) {
      stats.projects[m.project] = (stats.projects[m.project] || 0) + 1;
    }

    // language
    const ratio = cjkRatio(m.text);
    stats.language.cjk_ratio_sum += ratio;
    if (ratio > 0.3) stats.language.cjk_msg_count += 1;

    // habits
    stats.activity.len_sum += m.text.length;
    if (/[??]/.test(m.text)) stats.activity.question_count += 1;

    // chat imports
    if (m.source === "chat-import") {
      stats.chat.total += 1;
      if (m.from_user === true) stats.chat.from_user += 1;
      if (m.peer) {
        stats.chat.with_peer += 1;
        stats.chat.peers[m.peer] = (stats.chat.peers[m.peer] || 0) + 1;
      }
    }

    // keywords: reuse bus tokenizer (latin words + CJK uni/bigrams)
    for (const tok of tokenize(m.text)) {
      const isCjk = /[一-鿿]/.test(tok);
      if (isCjk) {
        if (tok.length >= 2 && !STOPWORDS.has(tok)) {
          stats.cjk_terms[tok] = (stats.cjk_terms[tok] || 0) + 1;
        }
      } else {
        if (!STOPWORDS.has(tok) && !TRIVIAL.has(tok) && !/^\d+$/.test(tok)) {
          stats.latin_terms[tok] = (stats.latin_terms[tok] || 0) + 1;
        }
      }
    }
  }

  // derivations
  stats.activity.active_days = Object.keys(stats.days).length;
  const dayList = Object.keys(stats.days).sort();
  let streak = 0, best = 0, prev = null;
  for (const d of dayList) {
    if (prev) {
      const gap = (new Date(d) - new Date(prev)) / 86400000;
      streak = gap === 1 ? streak + 1 : 1;
    } else streak = 1;
    best = Math.max(best, streak);
    prev = d;
  }
  stats.activity.longest_streak = best;
  stats.activity.top_days = topN(new Map(Object.entries(stats.days).map(([d, c]) => [d, c])), 10);
  stats.top_latin_terms = topN(new Map(Object.entries(stats.latin_terms)), 50);
  stats.top_cjk_terms = topN(new Map(Object.entries(stats.cjk_terms)), 50);
  stats.top_projects = topN(new Map(Object.entries(stats.projects)), 30);
  stats.top_peers = topN(new Map(Object.entries(stats.chat.peers)), 20);
  stats.samples.recent = recentRing;
  stats.language.avg_cjk_ratio = stats.total ? +(stats.language.cjk_ratio_sum / stats.total).toFixed(3) : 0;
  stats.language.cjk_msgs_ratio = stats.total ? +(stats.language.cjk_msg_count / stats.total).toFixed(3) : 0;
  stats.activity.avg_len = stats.total ? Math.round(stats.activity.len_sum / stats.total) : 0;
  stats.activity.question_ratio = stats.total ? +(stats.activity.question_count / stats.total).toFixed(3) : 0;
  stats.activity.night_ratio = stats.with_ts ? +(stats.activity.night_count / stats.with_ts).toFixed(3) : 0;
  stats.activity.weekend_ratio = stats.with_ts ? +(stats.activity.weekend_count / stats.with_ts).toFixed(3) : 0;

  // compact counters used only for top-N derivation
  delete stats.latin_terms;
  delete stats.cjk_terms;
  delete stats.projects;
  delete stats.chat.peers;
  delete stats.language.cjk_ratio_sum;
  delete stats.activity.len_sum;
  delete stats.activity.question_count;
  delete stats.activity.night_count;
  delete stats.activity.weekend_count;

  const statsFile = path.join(outDir, "stats.json");
  fs.writeFileSync(statsFile, JSON.stringify(stats, null, 2), "utf-8");
  return { statsFile, stats };
}
