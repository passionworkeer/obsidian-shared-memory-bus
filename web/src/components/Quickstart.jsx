import { useState } from "react";
import { useReveal, copyText } from "../hooks.js";

const STEPS = [
  {
    num: 1,
    title: "克隆仓库",
    cmd: "git clone https://github.com/passionworkeer/obsidian-shared-memory-bus.git\ncd obsidian-shared-memory-bus",
    note: null
  },
  {
    num: 2,
    title: "安装依赖",
    cmd: "npm install",
    note: null
  },
  {
    num: 3,
    title: "启动核心 MCP 服务",
    cmd: "npm start",
    note: "默认启动 fetch、time 和拆分式 memory 服务。"
  },
  {
    num: 4,
    title: "接入支持的客户端",
    cmd: "node setup-mcp.js --target=cursor",
    note: "可用 --help 查看目标，--dry-run 只预览。claude 目标指 Claude Desktop，不是 Claude Code。"
  }
];

const ENDPOINTS = [
  { k: "fetch", v: "http://127.0.0.1:9332/mcp" },
  { k: "time", v: "http://127.0.0.1:9333/mcp" },
  { k: "memory-retrieval", v: "http://127.0.0.1:9338/mcp" },
  { k: "memory-bridge", v: "http://127.0.0.1:9339/mcp" },
  { k: "memory-dream", v: "http://127.0.0.1:9340/mcp" },
  { k: "memory-mgmt", v: "http://127.0.0.1:9341/mcp" }
];

export default function Quickstart({ onToast }) {
  const { ref, inView } = useReveal();

  return (
    <section id="quickstart" className="section" aria-labelledby="qs-title">
      <div className="container">
        <header className={`section-head reveal${inView ? " in-view" : ""}`} ref={ref}>
          <p className="section-eyebrow">快速开始</p>
          <h2 id="qs-title" className="section-title">4 步完成接入</h2>
          <p className="section-desc">需要 Node.js ≥ 22。Obsidian 可选，Docker 当前为实验性入口。</p>
        </header>

        <div className="steps reveal in-view">
          {STEPS.map((step) => (
            <Step key={step.num} step={step} onToast={onToast} />
          ))}
        </div>

        <div className="mcp-endpoints reveal in-view">
          <p className="endpoints-title">默认 split 模式端点</p>
          <ul className="endpoint-list">
            {ENDPOINTS.map((endpoint) => (
              <li key={endpoint.k}>
                <code>{endpoint.k}</code>
                <span>{endpoint.v}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

function Step({ step, onToast }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const ok = await copyText(step.cmd);
    if (ok) {
      setCopied(true);
      onToast?.("命令已复制到剪贴板");
      setTimeout(() => setCopied(false), 1600);
    } else {
      onToast?.("复制失败，请手动选择命令");
    }
  };

  return (
    <div className="step">
      <div className="step-head">
        <span className="step-num">{step.num}</span>
        <span className="step-title">{step.title}</span>
        <button
          className={`copy-btn${copied ? " copied" : ""}`}
          onClick={handleCopy}
          aria-label={`复制 ${step.title} 命令`}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <rect x="4" y="4" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3"/>
            <rect x="2.5" y="2.5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3"/>
          </svg>
          <span>{copied ? "已复制" : "复制"}</span>
        </button>
      </div>
      <pre className="code-block">
        <code>{step.cmd}</code>
      </pre>
      {step.note && <p className="step-note">{step.note}</p>}
    </div>
  );
}
