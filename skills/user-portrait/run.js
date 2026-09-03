#!/usr/bin/env node
/**
 * skills/user-portrait/run.js
 * ---------------------------
 * CLI entry for the user-portrait skill.
 *
 *   node skills/user-portrait/run.js                    # 全流程: collect → analyze → render
 *   node skills/user-portrait/run.js collect [--limit 5000] [--sources claude-code,codex]
 *                                            [--home <dir>] [--redact default|strict|off]
 *   node skills/user-portrait/run.js analyze
 *   node skills/user-portrait/run.js render [--title 名字] [--no-inbox]
 *   node skills/user-portrait/run.js import-chat <导出文件或目录> [--peer 对方名]
 *   node skills/user-portrait/run.js status
 *
 * Output lives under <store>/portrait/ (store resolved via
 * bus/store-root.js, overridable with --store / --out).
 */

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { resolveStoreRoot } from "../../bus/store-root.js";
import { collectMessages, appendChatImport } from "./lib/collect.js";
import { analyzeMessages } from "./lib/analyze.js";
import { renderAll } from "./lib/render.js";
import { parseChatPath } from "./lib/sources/chat-import.js";

function usage() {
  console.log(`yt user-portrait — 从本机 AI 工具日志与导出聊天记录生成用户画像

用法:
  node skills/user-portrait/run.js [command] [options]

命令:
  (无)          全流程: 采集 → 分析 → 生成画像/仪表盘/总线回写
  collect       只采集 (--limit N 每源上限, 默认 10000; --sources 逗号分隔;
                --home 覆盖用户主目录; --redact default|strict|off)
  analyze       只分析 (读 messages.jsonl → stats.json)
  render        只渲染 (--title 画像主体名; --no-inbox 不写总线 inbox)
  import-chat   导入微信/QQ 导出文件 (.csv/.txt/.json/.html) 后自动重新分析渲染
  status        查看存储位置与已有产物

选项:
  --store PATH  覆盖记忆库根目录
  --out PATH    覆盖画像输出目录 (默认 <store>/portrait)`);
}

function parseArgs(argv) {
  const args = { _: [], cmd: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "--sources") args.sources = argv[++i].split(",").map((s) => s.trim());
    else if (a === "--home") args.home = path.resolve(argv[++i]);
    else if (a === "--redact") args.redact = argv[++i];
    else if (a === "--store") args.store = path.resolve(argv[++i]);
    else if (a === "--out") args.out = path.resolve(argv[++i]);
    else if (a === "--title") args.title = argv[++i];
    else if (a === "--peer") args.peer = argv[++i];
    else if (a === "--no-inbox") args.noInbox = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (!a.startsWith("--")) args._.push(a);
  }
  args.cmd = args._[0] || "all";
  return args;
}

function resolveOutDir(args) {
  if (args.out) return args.out;
  const storeRoot = args.store || resolveStoreRoot();
  return path.join(storeRoot, "portrait");
}

function storeRootOf(args) {
  return args.store || (args.out ? null : resolveStoreRoot());
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.cmd === "help") return usage();

  const outDir = resolveOutDir(args);
  const storeRoot = storeRootOf(args);

  if (args.cmd === "status") {
    console.log(`home        : ${os.homedir()}`);
    console.log(`store root  : ${args.store || "(resolved) " + resolveStoreRoot()}`);
    console.log(`portrait dir: ${outDir}`);
    for (const f of ["messages.jsonl", "stats.json", "PROFILE.md", "profile.json", "dashboard.html", "scan-report.json", "sources-report.md"]) {
      const p = path.join(outDir, f);
      console.log(`  ${fs.existsSync(p) ? "✓" : "—"} ${f}${fs.existsSync(p) ? `  (${fs.statSync(p).size} B)` : ""}`);
    }
    return;
  }

  if (args.cmd === "collect" || args.cmd === "all") {
    console.log(`[1/3] 采集用户消息 → ${outDir}`);
    const { report } = await collectMessages({
      outDir,
      home: args.home,
      limit: args.limit,
      sources: args.sources,
      redactMode: args.redact || "default",
    });
    for (const [id, r] of Object.entries(report.per_source)) {
      console.log(`      ${r.label.padEnd(14)} files=${String(r.files).padStart(3)} kept=${String(r.kept).padStart(6)} err=${r.errors.length}`);
    }
    console.log(`      合计留存 ${report.total_kept} 条 (去重丢弃 ${report.total_dropped_dedup}, 无效丢弃 ${report.total_dropped_build})`);
    if (args.cmd === "collect") return;
  }

  if (args.cmd === "analyze" || args.cmd === "all") {
    console.log(`[2/3] 分析 → stats.json`);
    const { stats } = await analyzeMessages(outDir);
    console.log(`      消息 ${stats.total} 条 ｜ 活跃 ${stats.activity.active_days} 天 ｜ 来源 ${Object.keys(stats.sources).length} 个`);
    if (args.cmd === "analyze") return;
    var pipelineStats = stats;
  }

  if (args.cmd === "render" || args.cmd === "all") {
    console.log(`[3/3] 渲染画像`);
    let stats = pipelineStats;
    if (!stats) {
      const statsFile = path.join(outDir, "stats.json");
      if (!fs.existsSync(statsFile)) {
        console.error(`未找到 ${statsFile},先运行 collect/analyze`);
        process.exitCode = 1;
        return;
      }
      stats = JSON.parse(fs.readFileSync(statsFile, "utf-8"));
    }
    const scanFile = path.join(outDir, "scan-report.json");
    const scan = fs.existsSync(scanFile) ? JSON.parse(fs.readFileSync(scanFile, "utf-8")) : null;
    const arts = renderAll(outDir, {
      stats,
      scan,
      storeRoot: args.noInbox ? null : storeRoot,
      title: args.title,
    });
    console.log(`      ✓ PROFILE.md       ${arts.profileMd}`);
    console.log(`      ✓ profile.json     ${arts.profileJson}`);
    console.log(`      ✓ dashboard.html   ${arts.dashboard} (${arts.bytes})`);
    console.log(`      ✓ sources-report   ${arts.sourcesReport}`);
    console.log(arts.inbox ? `      ✓ bus inbox 回写   ${arts.inbox}` : `      · inbox 回写已跳过`);
    console.log(`
下一步:
  1. 浏览器打开 dashboard.html 查看可视化
  2. 让任意 agent 按 skills/user-portrait/SKILL.md 第 4 步补写 PROFILE.md 第 6 节(定性画像)
  3. 微信/QQ 记录: 见 skills/user-portrait/README.md 导出指南,然后 import-chat`);
    return;
  }

  if (args.cmd === "import-chat") {
    const target = args._[1];
    if (!target) {
      console.error("用法: run.js import-chat <文件或目录> [--peer 对方名]");
      process.exitCode = 1;
      return;
    }
    console.log(`[chat] 解析 ${target}`);
    const parsed = parseChatPath(target);
    if (!parsed.messages.length) {
      console.error("未解析到任何消息:" + (parsed.errors.join("; ") || "文件为空"));
      process.exitCode = 1;
      return;
    }
    const { kept, perFile } = await appendChatImport(outDir, parsed, { defaultPeer: args.peer });
    console.log(`      解析 ${parsed.messages.length} 条,写入 ${kept} 条 → ${path.join(outDir, "messages.jsonl")}`);
    for (const [f, n] of Object.entries(perFile)) console.log(`      · ${f}: ${n}`);
    if (parsed.errors.length) console.log(`      ⚠ ${parsed.errors.length} 个解析警告(见 sources-report)`);
    const { stats } = await analyzeMessages(outDir);
    const scanFile = path.join(outDir, "scan-report.json");
    const scan = fs.existsSync(scanFile) ? JSON.parse(fs.readFileSync(scanFile, "utf-8")) : null;
    renderAll(outDir, { stats, scan, storeRoot, title: args.title });
    console.log(`      ✓ 画像已更新 (chat-import: ${stats.chat.total} 条)`);
    return;
  }

  console.error(`未知命令: ${args.cmd}`);
  usage();
  process.exitCode = 1;
}

main().catch((err) => {
  console.error("user-portrait 失败:", err.message);
  process.exitCode = 1;
});
