import { useState } from "react";
import { useReveal } from "../hooks.js";

const LAYERS = [
  {
    num: "01",
    title: "AI Clients",
    tag: "接入层",
    body: "支持 MCP HTTP 端点的客户端都可以接入。自动配置脚本只修改已验证配置路径的客户端。",
    details: [
      { k: "自动配置", v: "Claude Desktop / Cursor / Kiro / Windsurf / Cline / Roo / Goose" },
      { k: "人工接入", v: "Claude Code / Codex / Copilot / OpenCode 等" },
      { k: "预览", v: "node setup-mcp.js --target=<agent> --dry-run" }
    ]
  },
  {
    num: "02",
    title: "Core MCP Layer",
    tag: "协议层",
    body: "npm start 启动 fetch、time 和 memory 核心服务。默认 memory 拆分为 retrieval / bridge / dream / mgmt 四个进程。",
    details: [
      { k: "Utility", v: "fetch:9332 · time:9333" },
      { k: "Split memory", v: "9338 · 9339 · 9340 · 9341" },
      { k: "Compatibility", v: "AI_MEMORY_SERVER_MODE=monolithic → memory:9338" }
    ]
  },
  {
    num: "03",
    title: "Local Runtime",
    tag: "检索层",
    body: "bus、retrieval 和 ops 负责写入、检索、索引更新与 Markdown 派生。默认 hash embedding 可离线运行，远程后端为可选配置。",
    details: [
      { k: "检索", v: "BM25 / semantic / hybrid" },
      { k: "索引", v: "本地 hash 或可选 provider embedding" },
      { k: "运维", v: "export / migration / validation / doctor" }
    ]
  },
  {
    num: "04",
    title: "Resolved Store",
    tag: "存储层",
    body: "存储根由 resolver 决定，不固定等于某一个目录。可以显式指定本地 store，也可以桥接到 Obsidian vault。",
    details: [
      { k: "优先", v: "AI_MEMORY_STORE / AI_MEMORY_STORE_ROOT" },
      { k: "Vault", v: "检测到时使用 00-System/ai-memory" },
      { k: "回退", v: "AI_MEMORY_ROOT 或 ~/.ai-memory" }
    ]
  }
];

export default function Architecture() {
  const { ref, inView } = useReveal();
  const [active, setActive] = useState(null);

  return (
    <section id="architecture" className="section section-alt" aria-labelledby="arch-title">
      <div className="container">
        <header className={`section-head reveal${inView ? " in-view" : ""}`} ref={ref}>
          <p className="section-eyebrow">系统架构</p>
          <h2 id="arch-title" className="section-title">四层结构，边界明确</h2>
          <p className="section-desc">区分核心服务、可选集成和实际解析出的存储根，避免配置与运行状态漂移。</p>
        </header>

        <div className="arch-diagram reveal in-view">
          {LAYERS.map((layer, i) => (
            <div key={layer.num}>
              <div
                className={`arch-layer${active === i ? " is-active" : ""}`}
                onMouseEnter={() => setActive(i)}
                onMouseLeave={() => setActive(null)}
                onClick={() => setActive((current) => (current === i ? null : i))}
                role="button"
                tabIndex={0}
                aria-expanded={active === i}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setActive((current) => (current === i ? null : i));
                  }
                }}
              >
                <div className="arch-layer-head">
                  <span className="arch-num">{layer.num}</span>
                  <h3>{layer.title}</h3>
                  <span className="arch-tag">{layer.tag}</span>
                </div>
                <p className="arch-layer-body">{layer.body}</p>
                {active === i && (
                  <dl className="arch-detail">
                    {layer.details.map((detail) => (
                      <div key={detail.k}>
                        <dt>{detail.k}</dt>
                        <dd>{detail.v}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </div>
              {i < LAYERS.length - 1 && (
                <div className="arch-arrow" aria-hidden="true">
                  <span className="flow"></span>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
