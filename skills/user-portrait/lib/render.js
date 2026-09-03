/**
 * skills/user-portrait/lib/render.js
 * ---------------------------------
 * Derives the human/agent-facing artifacts from stats.json:
 *
 *   profile.json      — structured facts + empty qualitative slots
 *   PROFILE.md        — versioned profile (script facts + agent-fillable
 *                       sections; follows the ai-context conventions:
 *                       事实 vs 观察分离, 置信度标注, 隐私分级 P0-P3)
 *   dashboard.html    — single-file offline visualization (no CDN)
 *   sources-report.md — what was scanned / skipped / errors
 *   <store>/inbox/user-portrait.md — bus write-back so every agent
 *                       discovers the profile (SKILL.md manual fallback path)
 */

import fs from "node:fs";
import path from "node:path";
import { fmtBytes } from "./util.js";
import { DASHBOARD_HTML } from "./dashboard-template.js";

const WEEKDAY_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function fmtDate(ms) {
  if (!ms) return "—";
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function pct(x) {
  return `${Math.round((x || 0) * 100)}%`;
}

function topTermsBar(entries, max = 30) {
  return entries.slice(0, max).map((e) => `\`${e.t}\`(${e.n})`).join(" · ") || "—";
}

/** Render sources-report.md from scan-report.json + stats.json. */
export function renderSourcesReport(outDir, scan, stats) {
  const lines = [];
  lines.push("# 采集来源报告 / Sources Report");
  lines.push("");
  lines.push(`> 生成时间: ${(scan && scan.finished_at) || new Date().toISOString()}`);
  lines.push(`> 扫描主目录: \`${(scan && scan.home) || "—"}\` ｜ 消息留存: ${stats.total} 条(去重后)`);
  lines.push("");
  lines.push("| 来源 | 扫描文件 | 产出候选 | 留存 | 错误 |");
  lines.push("| --- | ---: | ---: | ---: | ---: |");
  for (const [id, r] of Object.entries((scan && scan.per_source) || {})) {
    lines.push(`| ${r.label} (\`${id}\`) | ${r.files} | ${r.yielded} | ${r.kept} | ${r.errors.length} |`);
  }
  if (stats.sources["chat-import"]) {
    lines.push(`| 聊天记录导入 (\`chat-import\`) | — | — | ${stats.sources["chat-import"].count} | — |`);
  }
  lines.push("");
  if (scan && scan.notes && scan.notes.length) {
    lines.push("**检测到但未解析的存储**:");
    for (const n of scan.notes) lines.push(`- ${n}`);
    lines.push("");
  }
  let errTotal = 0;
  for (const r of Object.values((scan && scan.per_source) || {})) {
    for (const e of r.errors) {
      if (errTotal < 20) lines.push(`- ⚠ ${e}`);
      errTotal += 1;
    }
  }
  if (errTotal > 20) lines.push(`- …另有 ${errTotal - 20} 条错误已省略`);
  const file = path.join(outDir, "sources-report.md");
  fs.writeFileSync(file, lines.join("\n"), "utf-8");
  return file;
}

/** Render profile.json (structured facts + qualitative slots). */
export function renderProfileJson(outDir, stats, opts = {}) {
  const profile = {
    v: 1,
    kind: "user-portrait",
    generated_at: stats.generated_at,
    subject: opts.title || null,
    privacy: {
      level: "P2",
      rule: "P0 可公开 / P1 低敏 / P2 高隐私 / P3 极高隐私;本文件默认按 P2 处理,不得进入公开材料",
    },
    coverage: {
      total_messages: stats.total,
      first_ts: stats.first_ts,
      last_ts: stats.last_ts,
      active_days: stats.activity.active_days,
      sources: Object.fromEntries(Object.entries(stats.sources).map(([k, v]) => [k, v.count])),
    },
    facts: {
      rhythm: {
        night_ratio: stats.activity.night_ratio,
        weekend_ratio: stats.activity.weekend_ratio,
        peak_hours: stats.hours
          .map((c, h) => ({ h, c }))
          .sort((a, b) => b.c - a.c)
          .slice(0, 3)
          .filter((x) => x.c > 0)
          .map((x) => x.h),
        longest_streak_days: stats.activity.longest_streak,
      },
      language: {
        cjk_msgs_ratio: stats.language.cjk_msgs_ratio,
        avg_message_len: stats.activity.avg_len,
        question_ratio: stats.activity.question_ratio,
      },
      top_terms: {
        latin: stats.top_latin_terms.slice(0, 25).map((e) => e.t),
        cjk: stats.top_cjk_terms.slice(0, 25).map((e) => e.t),
      },
      top_projects: stats.top_projects.slice(0, 15).map((e) => e.t),
      chat: stats.chat.total
        ? { total: stats.chat.total, from_user: stats.chat.from_user, peers: stats.top_peers.length }
        : null,
    },
    ai_sections: {
      one_liner: null,
      skills_directions: null,
      interests: null,
      working_style: null,
      collaboration_preferences: null,
      open_observations: null,
    },
  };
  const file = path.join(outDir, "profile.json");
  fs.writeFileSync(file, JSON.stringify(profile, null, 2), "utf-8");
  return { file, profile };
}

/** Render PROFILE.md — facts by script + fill-in sections for the agent. */
export function renderProfileMd(outDir, stats, opts = {}) {
  const spanDays = stats.first_ts && stats.last_ts ? Math.max(1, Math.round((stats.last_ts - stats.first_ts) / 86400000)) : 0;
  const peakHours = stats.hours
    .map((c, h) => ({ h, c }))
    .sort((a, b) => b.c - a.c)
    .filter((x) => x.c > 0)
    .slice(0, 3)
    .map((x) => `${x.h}:00-${x.h + 1}:00`);
  const topWeekday = stats.weekdays
    .map((c, d) => ({ d, c }))
    .sort((a, b) => b.c - a.c)[0];

  const L = [];
  L.push(`# 用户画像 / User Portrait`);
  L.push("");
  L.push(`> 生成时间: ${stats.generated_at.slice(0, 16)} ｜ 引擎: yt user-portrait skill`);
  L.push(`> 隐私等级: **P2(高隐私)** — 仅供本人与本地 AI 助手使用,不得进入公开材料`);
  L.push(`> 数据范围: ${fmtDate(stats.first_ts)} → ${fmtDate(stats.last_ts)}(约 ${spanDays} 天)`);
  L.push("");
  L.push(`## 1. 数据概览`);
  L.push("");
  L.push(`| 指标 | 值 |`);
  L.push(`| --- | --- |`);
  L.push(`| 用户消息总数(去重后) | ${stats.total} |`);
  L.push(`| 活跃天数 | ${stats.activity.active_days} 天 |`);
  L.push(`| 数据来源 | ${Object.entries(stats.sources).map(([k, v]) => `${k}(${v.count})`).join("、") || "—"} |`);
  if (stats.chat.total) {
    L.push(`| 聊天记录 | 导入 ${stats.chat.total} 条,本人发送 ${stats.chat.from_user} 条,涉及对话 ${stats.top_peers.length} 个 |`);
  }
  L.push("");
  L.push(`## 2. 活跃规律(脚本统计,事实)`);
  L.push("");
  L.push(`- 高峰时段: ${peakHours.join("、") || "—"}`);
  L.push(`- 最活跃: ${WEEKDAY_ZH[topWeekday ? topWeekday.d : 0]}(周末占比 ${pct(stats.activity.weekend_ratio)})`);
  L.push(`- 深夜(0-6 点)消息占比: ${pct(stats.activity.night_ratio)} ${stats.activity.night_ratio > 0.25 ? "→ 夜猫型" : stats.activity.night_ratio < 0.05 ? "→ 早睡型" : "→ 常规型"}`);
  L.push(`- 最长连续活跃: ${stats.activity.longest_streak} 天`);
  L.push(`- 最活跃的日子: ${stats.activity.top_days.slice(0, 5).map((d) => `${d.t}(${d.n}条)`).join("、") || "—"}`);
  L.push("");
  L.push(`## 3. 关注技术 / 高频词(脚本统计,事实)`);
  L.push("");
  L.push(`**技术/英文词 Top30**: ${topTermsBar(stats.top_latin_terms)}`);
  L.push("");
  L.push(`**中文高频词 Top30**: ${topTermsBar(stats.top_cjk_terms)}`);
  L.push("");
  L.push(`## 4. 项目足迹(来自会话工作目录)`);
  L.push("");
  if (stats.top_projects.length) {
    L.push(`| 项目 | 消息数 |`);
    L.push(`| --- | ---: |`);
    for (const p of stats.top_projects.slice(0, 15)) L.push(`| ${p.t} | ${p.n} |`);
  } else {
    L.push(`_(无项目目录信息)_`);
  }
  L.push("");
  L.push(`## 5. 表达与语言(脚本统计,事实)`);
  L.push("");
  L.push(`- 中文消息占比: ${pct(stats.language.cjk_msgs_ratio)}(混合中英: ${pct(stats.language.avg_cjk_ratio)} 汉字密度)`);
  L.push(`- 平均消息长度: ${stats.activity.avg_len} 字符`);
  L.push(`- 疑问句占比: ${pct(stats.activity.question_ratio)} ${stats.activity.question_ratio > 0.3 ? "→ 高频提问/探索型" : ""}`);
  L.push("");
  L.push(`## 6. AI 定性画像(由 agent 基于上方事实与消息样本填写)`);
  L.push("");
  L.push(`> 约定:每条观察标注置信度【高置信/中置信/待验证】;"事实"指用户原话或可验证数据,"观察"指 AI 推断,两者分开写。`);
  L.push("");
  L.push(`### 6.1 一句话画像`);
  L.push("");
  L.push(`_(待填写:一句话概括这个用户是谁、在做什么、核心追求)_`);
  L.push("");
  L.push(`### 6.2 核心技能与方向`);
  L.push("");
  L.push(`_(待填写:从高频词、项目足迹归纳 3-6 项技能方向,标注证据来源)_`);
  L.push("");
  L.push(`### 6.3 兴趣主题`);
  L.push("");
  L.push(`_(待填写:技术之外的兴趣线索)_`);
  L.push("");
  L.push(`### 6.4 工作方式`);
  L.push("");
  L.push(`_(待填写:节奏(夜型/日型)、深度(长任务/短迭代)、探索型还是目标型)_`);
  L.push("");
  L.push(`### 6.5 协作偏好(供其他 AI 助手参考)`);
  L.push("");
  L.push(`_(待填写:语言偏好、回复风格偏好、上下文习惯)_`);
  L.push("");
  L.push(`### 6.6 待验证观察`);
  L.push("");
  L.push(`_(待填写:置信度不足但值得继续观察的判断)_`);
  L.push("");
  L.push(`## 7. 隐私与使用规则`);
  L.push("");
  L.push(`- 本文件及 messages.jsonl 属 **P2 高隐私**,仅限本地存储;`);
  L.push(`- 引用本画像回复时,不得把原文粘贴进公开渠道(博客/issue/群聊);`);
  L.push(`- 凭据类内容已在采集时自动脱敏(\`[REDACTED:*]\`);若发现漏网敏感信息,请立即修 messages.jsonl 并报告;`);
  L.push(`- 更新画像:重跑 \`npm run portrait\` 或让 agent 按 SKILL.md 流程补写第 6 节。`);
  L.push("");
  if (opts.title) {
    L.push(`---`);
    L.push(`> 画像主体: ${opts.title}`);
  }
  const file = path.join(outDir, "PROFILE.md");
  fs.writeFileSync(file, L.join("\n"), "utf-8");
  return file;
}

/** Render dashboard.html with stats embedded. */
export function renderDashboard(outDir, stats) {
  const file = path.join(outDir, "dashboard.html");
  const html = DASHBOARD_HTML.replace("__PORTRAIT_DATA__", JSON.stringify(stats).replace(/</g, "\\u003c"));
  fs.writeFileSync(file, html, "utf-8");
  return file;
}

/**
 * Write a durable pointer into the bus inbox so agents using the shared
 * memory discover the portrait (per root SKILL.md manual write protocol).
 */
export function writeInboxPointer(storeRoot, outDir, stats) {
  if (!storeRoot) return null;
  const inboxDir = path.join(storeRoot, "inbox");
  try {
    fs.mkdirSync(inboxDir, { recursive: true });
    const file = path.join(inboxDir, "user-portrait.md");
    const note = [
      "## Agent: user-portrait",
      "",
      `- ${new Date().toISOString().slice(0, 16)} 用户画像已生成: ${stats.total} 条用户消息(去重),画像文件 \`${path.join(outDir, "PROFILE.md")}\`,结构化数据 \`profile.json\`,可视化 \`dashboard.html\`。`,
      `- 读取画像请优先打开 PROFILE.md(第 1-5 节为脚本统计事实,第 6 节为定性画像)。涉及隐私(P2),仅用于服务用户本人。`,
      "",
    ].join("\n");
    // append-only convention like other inbox notes
    const prev = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
    const fresh = prev.includes("用户画像已生成")
      ? note // replace stale pointer instead of growing unbounded
      : prev + note;
    fs.writeFileSync(file, fresh, "utf-8");
    return file;
  } catch {
    return null;
  }
}

/** Full render pass. Returns artifact paths. */
export function renderAll(outDir, { stats, scan, storeRoot, title }) {
  const profileJson = renderProfileJson(outDir, stats, { title });
  const profileMd = renderProfileMd(outDir, stats, { title });
  const dashboard = renderDashboard(outDir, stats);
  const sourcesReport = renderSourcesReport(outDir, scan, stats);
  const inbox = writeInboxPointer(storeRoot, outDir, stats);
  return { profileJson: profileJson.file, profileMd, dashboard, sourcesReport, inbox, bytes: fmtBytes(fs.statSync(dashboard).size) };
}
