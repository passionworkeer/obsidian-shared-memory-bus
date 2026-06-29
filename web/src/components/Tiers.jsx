import { useState } from "react";
import { useReveal } from "../hooks.js";

const TIERS = [
  {
    key: "L0",
    name: "Working",
    width: "16%",
    meta: "当前会话工作内存 · 内存",
    detail: [
      { k: "持久化", v: "内存" },
      { k: "生命周期", v: "进程关闭即丢" },
      { k: "用途", v: "当前会话上下文缓存" }
    ]
  },
  {
    key: "L1",
    name: "Session",
    width: "30%",
    meta: "短时记忆 · 7 天滚动 · structured/",
    detail: [
      { k: "持久化", v: "structured/session.jsonl" },
      { k: "生命周期", v: "7 天滚动" },
      { k: "用途", v: "近期会话短时记忆" }
    ]
  },
  {
    key: "L2",
    name: "Essential",
    width: "48%",
    meta: "关键项目信息 · structured/",
    detail: [
      { k: "持久化", v: "structured/" },
      { k: "生命周期", v: "项目级长期" },
      { k: "用途", v: "项目栈、约定、关键决策" }
    ]
  },
  {
    key: "L3",
    name: "Durable",
    width: "64%",
    meta: "长期知识库 · 进向量空间 · durable/",
    detail: [
      { k: "持久化", v: "durable/ + 向量索引" },
      { k: "检索", v: "进 BM25 + Dense 空间" },
      { k: "用途", v: "跨项目长期知识库" }
    ]
  },
  {
    key: "L4",
    name: "Reference",
    width: "80%",
    meta: "参考文档 · reference/",
    detail: [
      { k: "持久化", v: "reference/" },
      { k: "生命周期", v: "手动维护" },
      { k: "用途", v: "外部参考、引用文档" }
    ]
  },
  {
    key: "L5",
    name: "Archive",
    width: "96%",
    dim: true,
    meta: "归档 · 不进向量空间 · archive-manifest.jsonl",
    detail: [
      { k: "持久化", v: "archive-manifest.jsonl" },
      { k: "检索", v: "不进入向量空间" },
      { k: "用途", v: "冷存储归档" }
    ]
  }
];

export default function Tiers() {
  const { ref, inView } = useReveal();
  const [active, setActive] = useState(null);

  return (
    <section id="tiers" className="section section-alt" aria-labelledby="tiers-title">
      <div className="container">
        <header className={`section-head reveal${inView ? " in-view" : ""}`} ref={ref}>
          <p className="section-eyebrow">记忆分层</p>
          <h2 id="tiers-title" className="section-title">L0 — L5 阶梯式生命周期</h2>
          <p className="section-desc">不同热度、不同成本的记忆自动落到合适的层级。点击层级查看持久化与生命周期详情。</p>
        </header>

        <ol className="tier-ladder reveal in-view">
          {TIERS.map((tier, i) => (
            <li
              key={tier.key}
              className={`tier${active === i ? " is-active" : ""}`}
              onClick={() => setActive((cur) => (cur === i ? null : i))}
              onMouseEnter={() => setActive(i)}
              onMouseLeave={() => setActive(null)}
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
              <div className="tier-label">
                <span className="tier-key">{tier.key}</span>
                <span className="tier-name">{tier.name}</span>
              </div>
              <div className="tier-bar-wrap">
                <div
                  className={`tier-bar${tier.dim ? " tier-bar-dim" : ""}`}
                  style={{ "--tier-w": tier.width }}
                ></div>
              </div>
              <div className="tier-meta">{tier.meta}</div>
              {active === i && (
                <dl className="tier-detail">
                  {tier.detail.map((d) => (
                    <div key={d.k}>
                      <dt>{d.k}</dt>
                      <dd>{d.v}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
