# 中文短视频分镜：让多个 AI 工具共享记忆

## 版本 A：60 秒

### 0-5 秒：痛点

画面：屏幕上同时出现 Codex、Claude Code、Cursor、Copilot，每个窗口都显示“请重新解释项目背景”。

旁白：

> 你有没有发现，用的 AI 工具越多，重复解释上下文越累？

### 5-15 秒：问题放大

画面：同一个项目，被四个工具分成四份孤岛记忆。

旁白：

> Codex 刚帮你梳理完架构，切到 Claude Code 又要重讲一遍。Cursor 排查过的坑，Copilot 还是不知道。

### 15-30 秒：解决方案

画面：四个工具连接到同一个本地 memory bus。

旁白：

> Local AI Memory Bus 做的是一件简单的事：让多个 AI 编程工具共享同一份本地记忆。

### 30-45 秒：架构

画面：AI Clients → Shared MCP → Hybrid Retrieval → `.ai-memory` Store。

旁白：

> 数据放在本地 `.ai-memory`，MCP 只负责传输，检索用 BM25 加向量混合排序。

### 45-55 秒：演示

画面：Codex 写入任务决策，Claude Code 搜索到并继续实现，Copilot 读取同一份上下文。

旁白：

> 一个工具留下的决策，另一个工具可以直接接上。

### 55-60 秒：收尾

画面：项目 logo 或 hero 图。

旁白：

> 不要让记忆困在某个工具里。让它属于你的本地开发环境。

## 屏幕字幕

- 多 AI 工具共享记忆
- 本地优先，不绑定 SaaS
- MCP 共享端点
- BM25 + 向量混合检索
- Codex / Claude Code / Cursor / Copilot
