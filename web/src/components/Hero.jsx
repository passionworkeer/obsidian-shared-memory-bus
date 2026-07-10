import { useReveal } from "../hooks.js";

export default function Hero() {
  const { ref, inView } = useReveal();

  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="hero-bg" aria-hidden="true">
        <div className="hero-grid"></div>
        <div className="hero-glow"></div>
      </div>
      <div className="container hero-inner">
        <div className={`hero-copy reveal${inView ? " in-view" : ""}`} ref={ref}>
          <p className="eyebrow">
            <span className="dot"></span> v3.1.0 · 本地优先 · 无 SaaS 依赖
          </p>
          <h1 id="hero-title" className="hero-title">
            让所有 AI 工具<br />
            共享<span className="accent">同一份记忆</span>
          </h1>
          <p className="hero-sub">
            Claude / Cursor / Kiro / Windsurf / Cline / Roo / Goose / Qoder —
            统一接入本地 MCP 记忆后端,跨会话保留上下文,不再每次从头解释项目背景。
          </p>
          <div className="hero-cta">
            <a className="btn btn-primary" href="#quickstart">
              快速开始
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <path d="M4 8h7M7.5 4.5L11 8l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </a>
            <a className="btn btn-ghost" href="#architecture">查看架构</a>
          </div>
          <ul className="hero-meta" aria-label="关键指标">
            <li><strong>1300</strong><span>测试 · 全绿 0 fail</span></li>
            <li><strong>8</strong><span>支持的 AI 工具</span></li>
            <li><strong>0</strong><span>外部 SaaS 依赖</span></li>
          </ul>
        </div>

        <div className="hero-visual reveal in-view" aria-hidden="true">
          <HeroDiagram />
        </div>
      </div>
    </section>
  );
}

/** Inline animated SVG diagram: clients → MCP → runtime → canonical store. */
function HeroDiagram() {
  const clients = ["Claude", "Cursor", "Kiro", "Windsurf", "Cline", "Qoder"];
  const mcpServices = ["memory:9338", "context7:9331", "playwright:9337"];
  const runtimeModules = ["BM25", "Dense", "Hybrid", "watchdog"];

  return (
    <svg className="hero-diagram" viewBox="0 0 420 380" role="img" aria-label="共享记忆架构示意">
      <defs>
        <linearGradient id="flow-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#00d4aa" stopOpacity="0"/>
          <stop offset="50%" stopColor="#00d4aa" stopOpacity="0.9"/>
          <stop offset="100%" stopColor="#00d4aa" stopOpacity="0"/>
        </linearGradient>
      </defs>

      {/* Clients layer */}
      <Layer rectX={30} rectY={20} label="CLIENTS" />
      {clients.map((c, i) => (
        <Pill key={c} x={44 + i * 58} y={48} w={50} label={c} />
      ))}

      <FlowArrow x={210} y1={80} y2={120} delay="0s" />

      {/* MCP layer */}
      <Layer rectX={30} rectY={120} label="SHARED MCP LAYER" accent />
      {mcpServices.map((s, i) => (
        <Pill key={s} x={44 + i * 108} y={148} w={100} label={s} subtle />
      ))}

      <FlowArrow x={210} y1={180} y2={220} delay="0.5s" />

      {/* Runtime layer */}
      <Layer rectX={30} rectY={220} label="LOCAL RUNTIME" />
      {runtimeModules.map((m, i) => (
        <Pill key={m} x={44 + i * 88} y={248} w={78} label={m} subtle />
      ))}

      <FlowArrow x={210} y1={280} y2={320} delay="1s" />

      {/* Store layer */}
      <Layer rectX={30} rectY={320} label="CANONICAL STORE" accent height={48} />
      <text x="210" y="358" textAnchor="middle" fontFamily="monospace" fontSize="11" fill="rgba(255,255,255,0.85)">
        vault · 00-System/ai-memory/
      </text>
    </svg>
  );
}

function Layer({ rectX, rectY, label, accent = false, height = 56 }) {
  return (
    <g>
      <rect
        x={rectX}
        y={rectY}
        width={360}
        height={height}
        rx={10}
        fill={accent ? "rgba(0,212,170,0.06)" : "rgba(255,255,255,0.03)"}
        stroke={accent ? "rgba(0,212,170,0.5)" : "rgba(255,255,255,0.12)"}
      />
      <text
        x={rectX + 18}
        y={rectY + 20}
        fill={accent ? "var(--accent)" : "rgba(255,255,255,0.5)"}
        fontSize="10"
        fontFamily="monospace"
      >
        {label}
      </text>
    </g>
  );
}

function Pill({ x, y, w, label, subtle = false }) {
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={w}
        height={20}
        rx={10}
        fill={subtle ? "rgba(255,255,255,0.04)" : "rgba(0,212,170,0.12)"}
        stroke={subtle ? "rgba(255,255,255,0.18)" : "rgba(0,212,170,0.4)"}
      />
      <text
        x={x + w / 2}
        y={y + 14}
        textAnchor="middle"
        fontFamily="monospace"
        fontSize="11"
        fill="rgba(255,255,255,0.85)"
      >
        {label}
      </text>
    </g>
  );
}

function FlowArrow({ x, y1, y2, delay }) {
  return (
    <line
      x1={x}
      y1={y1}
      x2={x}
      y2={y2}
      stroke="url(#flow-grad)"
      strokeWidth={2}
      strokeDasharray="40"
    >
      <animate
        attributeName="stroke-dashoffset"
        values="40;0"
        dur="2s"
        begin={delay}
        repeatCount="indefinite"
      />
    </line>
  );
}
