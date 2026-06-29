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
    title: "启动 MCP 服务器",
    cmd: "node start.js",
    note: "也可双击 start.bat(Windows)。"
  },
  {
    num: 4,
    title: "接入你的 AI 工具",
    cmd: "node setup-mcp.js --target=claude",
    note: "自动检测并写入配置。--target=all 一键接入全部 8 个工具。--dry-run 预览不写入。"
  }
];

const ENDPOINTS = [
  { k: "memory", v: "http://127.0.0.1:9338/mcp" },
  { k: "context7", v: "http://127.0.0.1:9331/mcp" },
  { k: "fetch", v: "http://127.0.0.1:9332/mcp" },
  { k: "time", v: "http://127.0.0.1:9333/mcp" },
  { k: "playwright", v: "http://127.0.0.1:9337/mcp" }
];

export default function Quickstart({ onToast }) {
  const { ref, inView } = useReveal();

  return (
    <section id="quickstart" className="section" aria-labelledby="qs-title">
      <div className="container">
        <header className={`section-head reveal${inView ? " in-view" : ""}`} ref={ref}>
          <p className="section-eyebrow">快速开始</p>
          <h2 id="qs-title" className="section-title">4 步完成接入</h2>
          <p className="section-desc">需要 Node.js ≥ 18。整个过程在本地完成,无需注册账号。</p>
        </header>

        <div className="steps reveal in-view">
          {STEPS.map((s) => (
            <Step key={s.num} step={s} onToast={onToast} />
          ))}
        </div>

        <div className="mcp-endpoints reveal in-view">
          <p className="endpoints-title">MCP 端点一览</p>
          <ul className="endpoint-list">
            {ENDPOINTS.map((e) => (
              <li key={e.k}>
                <code>{e.k}</code>
                <span>{e.v}</span>
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
      onToast?.("复制失败,请手动选择命令");
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
