import { useState } from "react";
import { useReveal } from "../hooks.js";

const TABS = [
  {
    id: "by-tier",
    label: "按支持等级",
    tools: [
      { name: "Claude Code", status: "一级", primary: true, note: "完整集成验证" },
      { name: "Codex", status: "一级", primary: true, note: "完整集成验证" },
      { name: "OpenCode", status: "一级", primary: true, note: "完整集成验证" },
      { name: "Cursor", status: "支持", primary: false, note: "MCP 配置接入" },
      { name: "Kiro", status: "支持", primary: false, note: "MCP 配置接入" },
      { name: "Windsurf", status: "支持", primary: false, note: "MCP 配置接入" },
      { name: "Cline", status: "支持", primary: false, note: "MCP 配置接入" },
      { name: "Roo Code", status: "支持", primary: false, note: "MCP 配置接入" }
    ]
  },
  {
    id: "by-method",
    label: "按接入方式",
    tools: [
      { name: "Claude", status: "MCP", primary: true, note: "config 自动写入" },
      { name: "Cursor", status: "MCP", primary: true, note: "mcp.json" },
      { name: "Kiro", status: "MCP", primary: true, note: "MCP 配置" },
      { name: "Windsurf", status: "MCP", primary: true, note: "MCP 配置" },
      { name: "Cline", status: "MCP", primary: true, note: "MCP 配置" },
      { name: "Roo Code", status: "MCP", primary: true, note: "MCP 配置" },
      { name: "Goose", status: "MCP", primary: true, note: "MCP 配置" },
      { name: "Qoder", status: "MCP", primary: true, note: "路径待实测" }
    ]
  },
  {
    id: "all",
    label: "全部 8 agent",
    tools: [
      { name: "Claude Code", status: "claude", primary: true, note: "一级" },
      { name: "Cursor", status: "cursor", primary: false, note: "MCP" },
      { name: "Kiro", status: "kiro", primary: false, note: "MCP" },
      { name: "Windsurf", status: "windsurf", primary: false, note: "MCP" },
      { name: "Cline", status: "cline", primary: false, note: "MCP" },
      { name: "Roo Code", status: "roo", primary: false, note: "MCP" },
      { name: "Goose", status: "goose", primary: false, note: "MCP" },
      { name: "Qoder", status: "qoder", primary: false, note: "MCP" }
    ]
  }
];

export default function Tools() {
  const { ref, inView } = useReveal();
  const [activeTab, setActiveTab] = useState(TABS[0].id);
  const active = TABS.find((t) => t.id === activeTab);

  return (
    <section id="tools" className="section" aria-labelledby="tools-title">
      <div className="container">
        <header className={`section-head reveal${inView ? " in-view" : ""}`} ref={ref}>
          <p className="section-eyebrow">生态兼容</p>
          <h2 id="tools-title" className="section-title">支持 8 个主流 AI 工具</h2>
          <p className="section-desc">通过 MCP 协议接入,新增 agent 只需在 AGENT_REGISTRY 加一行。一键全接:<code>node setup-mcp.js --target=all</code></p>
        </header>

        <div className="tool-tabs reveal in-view" role="tablist" aria-label="工具视图">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={activeTab === t.id}
              className={`tool-tab${activeTab === t.id ? " is-active" : ""}`}
              onClick={() => setActiveTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <ul className="tool-pills" key={activeTab} aria-live="polite">
          {active.tools.map((tool, i) => (
            <li
              key={`${active.id}-${tool.name}`}
              className="tool-pill"
              style={{ animationDelay: `${i * 50}ms` }}
              title={tool.note}
            >
              <span className={`pill-status${tool.primary ? " pill-primary" : ""}`}>
                {tool.status}
              </span>
              <span>{tool.name}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
