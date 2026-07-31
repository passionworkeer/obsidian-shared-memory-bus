import { useState } from "react";
import { useReveal } from "../hooks.js";

const TABS = [
  {
    id: "automatic",
    label: "自动配置",
    tools: [
      { name: "Claude Desktop", status: "claude", primary: true, note: "已验证桌面配置路径" },
      { name: "Cursor", status: "cursor", primary: true, note: "~/.cursor/mcp.json" },
      { name: "Kiro", status: "kiro", primary: false, note: "MCP settings" },
      { name: "Windsurf", status: "windsurf", primary: false, note: "MCP config" },
      { name: "Cline", status: "cline", primary: false, note: "VS Code globalStorage" },
      { name: "Roo Code", status: "roo", primary: false, note: "VS Code globalStorage" },
      { name: "Goose", status: "goose", primary: false, note: "安全生成受管理 YAML block" }
    ]
  },
  {
    id: "manual",
    label: "人工接入",
    tools: [
      { name: "Claude Code", status: "MCP", primary: true, note: "手动填写 HTTP 端点或使用 Agent Skill" },
      { name: "Codex", status: "MCP", primary: true, note: "手动填写 HTTP 端点或使用 Agent Skill" },
      { name: "VS Code / Copilot", status: "MCP", primary: false, note: "按客户端文档配置" },
      { name: "OpenCode", status: "MCP", primary: false, note: "按客户端文档配置" },
      { name: "Trae", status: "模板", primary: false, note: "使用 AGENTS.md/模板" },
      { name: "Qoder", status: "提示", primary: false, note: "磁盘路径未经官方确认，不自动创建" }
    ]
  },
  {
    id: "boundary",
    label: "能力边界",
    tools: [
      { name: "任何 MCP 客户端", status: "可连接", primary: true, note: "客户端需支持 streamable HTTP MCP" },
      { name: "自动写配置", status: "有限", primary: false, note: "只覆盖已验证路径" },
      { name: "可选 MCP", status: "不自启", primary: false, note: "manifest 中的可选服务不由 npm start 启动" },
      { name: "Docker", status: "实验性", primary: false, note: "不是推荐首次安装入口" }
    ]
  }
];

export default function Tools() {
  const { ref, inView } = useReveal();
  const [activeTab, setActiveTab] = useState(TABS[0].id);
  const active = TABS.find((tab) => tab.id === activeTab);

  return (
    <section id="tools" className="section" aria-labelledby="tools-title">
      <div className="container">
        <header className={`section-head reveal${inView ? " in-view" : ""}`} ref={ref}>
          <p className="section-eyebrow">生态兼容</p>
          <h2 id="tools-title" className="section-title">区分协议兼容与自动配置</h2>
          <p className="section-desc">支持 MCP 不代表脚本能安全修改该客户端。先用 <code>node setup-mcp.js --help</code> 查看已验证目标。</p>
        </header>

        <div className="tool-tabs reveal in-view" role="tablist" aria-label="工具视图">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              role="tab"
              aria-selected={activeTab === tab.id}
              className={`tool-tab${activeTab === tab.id ? " is-active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <ul className="tool-pills" key={activeTab} aria-live="polite">
          {active.tools.map((tool, index) => (
            <li
              key={`${active.id}-${tool.name}`}
              className="tool-pill"
              style={{ animationDelay: `${index * 50}ms` }}
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
