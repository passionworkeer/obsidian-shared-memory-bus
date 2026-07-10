import { useState } from "react";
import { useReveal } from "../hooks.js";

const LAYERS = [
  {
    num: "01",
    title: "AI Clients",
    tag: "接入层",
    body: "任何支持 MCP 协议的 AI 编程工具都可作为客户端。每个工具保留各自原生的记忆格式,由 bus 统一翻译。",
    details: [
      { k: "工具", v: "Claude / Cursor / Kiro / Windsurf / Cline / Roo / Goose / Qoder" },
      { k: "接入", v: "node setup-mcp.js --target=<agent>" },
      { k: "全接", v: "node setup-mcp.js --target=all" }
    ]
  },
  {
    num: "02",
    title: "Shared MCP Layer",
    tag: "协议层",
    body: "本地 MCP 服务器集群对外提供统一接口。memory:9338 是核心,context7 / fetch / time / playwright 是配套工具。",
    details: [
      { k: "Memory", v: "http://127.0.0.1:9338/mcp" },
      { k: "Fetch", v: "http://127.0.0.1:9332/mcp" },
      { k: "Context7", v: "http://127.0.0.1:9331/mcp" },
      { k: "Playwright", v: "http://127.0.0.1:9337/mcp" }
    ]
  },
  {
    num: "03",
    title: "Local Runtime",
    tag: "检索层",
    body: "bus / watchdog 进程编排写入与同步。BM25 + Dense + Hybrid 三路并行召回,本地 LSH 哈希或可选 OpenAI / HF / Gemini 向量。",
    details: [
      { k: "检索", v: "search_shared_memory (语义) vs memory_search (BM25)" },
      { k: "融合", v: "weighted 安全回退 / RRF 高质量融合" },
      { k: "评测", v: "retrieval/eval NDCG@5 / Recall@10 / MRR" }
    ]
  },
  {
    num: "04",
    title: "Canonical Store",
    tag: "存储层",
    body: "Obsidian vault 的 00-System/ai-memory/ 是唯一可信来源。structured / inbox / generated 三种用途,所有工具最终都收敛到这里。",
    details: [
      { k: "发现", v: "自动读取 obsidian.json 发现任意盘符 vault" },
      { k: "结构", v: "structured/ · inbox/ · generated/" },
      { k: "覆盖", v: "AI_MEMORY_STORE 显式设置可覆盖" }
    ]
  }
];

export default function Architecture() {
  const { ref, inView } = useReveal();
  const [active, setActive] = useState(null); // index or null

  return (
    <section id="architecture" className="section section-alt" aria-labelledby="arch-title">
      <div className="container">
        <header className={`section-head reveal${inView ? " in-view" : ""}`} ref={ref}>
          <p className="section-eyebrow">系统架构</p>
          <h2 id="arch-title" className="section-title">四层结构,职责清晰</h2>
          <p className="section-desc">从客户端到存储,每一层都可独立替换或扩展。点击或悬停层级查看详情。</p>
        </header>

        <div className="arch-diagram reveal in-view">
          {LAYERS.map((layer, i) => (
            <div key={layer.num}>
              <div
                className={`arch-layer${active === i ? " is-active" : ""}`}
                onMouseEnter={() => setActive(i)}
                onMouseLeave={() => setActive(null)}
                onClick={() => setActive((cur) => (cur === i ? null : i))}
                role="button"
                tabIndex={0}
                aria-expanded={active === i}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setActive((cur) => (cur === i ? null : i));
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
                    {layer.details.map((d) => (
                      <div key={d.k}>
                        <dt>{d.k}</dt>
                        <dd>{d.v}</dd>
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
