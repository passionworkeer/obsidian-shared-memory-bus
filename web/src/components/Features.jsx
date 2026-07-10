import { useReveal } from "../hooks.js";

const FEATURES = [
  {
    title: "共享记忆",
    icon: (
      <path d="M17 7l-1.5 1.5L17 10l1.5-1.5L17 7zM12 4a8 8 0 00-8 8 8 8 0 008 8 8 8 0 008-8 8 8 0 00-8-8zm0 1.5A6.5 6.5 0 0118.5 12 6.5 6.5 0 0112 18.5 6.5 6.5 0 015.5 12 6.5 6.5 0 0112 5.5zM7 15l2 2 8-8-2-2-8 8z" fill="currentColor"/>
    ),
    desc: "Claude 写入的项目背景,Cursor 和 Kiro 下一次会话直接读取。跨工具、跨会话保留上下文。"
  },
  {
    title: "本地优先",
    icon: (
      <path d="M12 2L4 5v6c0 5 3.4 9.6 8 11 4.6-1.4 8-6 8-11V5l-8-3zm0 2.18l6 2.25v4.57c0 4.13-2.7 7.86-6 9-3.3-1.14-6-4.87-6-9V6.43l6-2.25z" fill="currentColor"/>
    ),
    desc: "数据存在本地 vault 的 00-System/ai-memory/ 目录,默认不联网,不依赖任何 SaaS。可离线运行。"
  },
  {
    title: "混合检索",
    icon: (
      <>
        <path d="M11 4l-1 4h4l-3 8 1-4H8l3-8z" fill="currentColor"/>
        <circle cx="11" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.4"/>
      </>
    ),
    desc: "BM25 + 语义向量双重召回,可选 RRF 融合,内置 jieba 中文分词,既精准又理解近义。"
  },
  {
    title: "MCP 协议",
    icon: (
      <>
        <path d="M9 4v2H7v14h10V6h-2V4H9zm2 2h2v2h-2V6zM8 8h8v10H8V8z" fill="currentColor"/>
        <path d="M10 11h4M10 14h4" stroke="currentColor" strokeWidth="1.2"/>
      </>
    ),
    desc: "原生支持 Model Context Protocol,2026 事实标准(SDK 月下载 97M),任何 MCP 工具都能接入。"
  },
  {
    title: "watchdog 观察者",
    icon: (
      <>
        <circle cx="12" cy="12" r="3" fill="currentColor"/>
        <path d="M12 4v3M12 17v3M4 12h3M17 12h3M6.3 6.3l2.1 2.1M15.6 15.6l2.1 2.1M6.3 17.7l2.1-2.1M15.6 8.4l2.1-2.1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
      </>
    ),
    desc: "后台 watchdog 观察闭源工具记忆文件,自动归并去重写入 canonical store,无需工具主动配合。"
  },
  {
    title: "6 层记忆分层",
    icon: (
      <>
        <path d="M5 5h14v4H5zM5 11h14v4H5zM5 17h14v2H5z" fill="none" stroke="currentColor" strokeWidth="1.6"/>
        <circle cx="8" cy="7" r="1" fill="currentColor"/>
        <circle cx="8" cy="13" r="1" fill="currentColor"/>
      </>
    ),
    desc: "L0 Working → L5 Archive,逐层晋升与遗忘,按生命周期和成本自动归档。"
  }
];

export default function Features() {
  const { ref, inView } = useReveal();

  return (
    <section id="features" className="section" aria-labelledby="features-title">
      <div className="container">
        <header className={`section-head reveal${inView ? " in-view" : ""}`} ref={ref}>
          <p className="section-eyebrow">核心特性</p>
          <h2 id="features-title" className="section-title">本地优先的工程级记忆系统</h2>
          <p className="section-desc">不是又一个云笔记,而是把记忆当作本地数据基础设施来设计。</p>
        </header>

        <div className="features-grid">
          {FEATURES.map((f) => (
            <FeatureCard key={f.title} feature={f} />
          ))}
        </div>
      </div>
    </section>
  );
}

function FeatureCard({ feature }) {
  const { ref, inView } = useReveal();
  return (
    <article className={`feature-card reveal${inView ? " in-view" : ""}`} ref={ref}>
      <div className="feature-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24">{feature.icon}</svg>
      </div>
      <h3>{feature.title}</h3>
      <p>{feature.desc}</p>
    </article>
  );
}
