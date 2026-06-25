# AGENTS.md · 项目协作规范（给 AI coding agents 读）

> ⚠️ 注意：项目根目录的 `AGENTS.md` 由 [GitNexus](https://gitnexus.dev) 等工具运行时注入，**不**要手工编辑它。本文件 `docs/AGENTS.md` 是项目维护者给任何 AI agent 读的项目规范。

---

## 项目一句话

**让多个 AI 工具共享同一个本地记忆**。技术栈：Node.js + Python + PowerShell 混合栈，主入口 MCP（Model Context Protocol）服务器，跨语言（JS ↔ Py）通过共享 LSH 哈希和契约测试保证等价。

---

## 必读（开工前）

1. [CLAUDE.md](../CLAUDE.md) — 分支策略、提交信息规范、代码质量约束
2. [docs/ARCHITECTURE.md](ARCHITECTURE.md) — 系统架构
3. [tech-debt-roadmap.md](../tech-debt-roadmap.md) — 当前活跃技术债清单
4. [PROJECT_ANALYSIS.md](../PROJECT_ANALYSIS.md) — 差分审计报告（最近一次）

---

## 核心约束（不要违反）

### 1. JSONL 是唯一真相源

- 所有结构化记忆存为 `~/.ai-memory/structured/*.jsonl`（append-only）
- **绝不**改写已有行（破坏 mtime + LSN 假设）
- 任何 "删除" 都通过 tombstone（写一条 op=delete 的事件）而不是物理删除

### 2. 跨语言等价

- 任何 LSH / hash / canonicalization 算法变更必须**同时**改 `bus/lsh-hash.js` 和 `retrieval/lsh_utils.py`
- 跑 `npm run test:cross` + `pytest tests/unit/py/test_lsh_utils.py -v` 验证
- 见 [specs/lsh-fixture.json](../specs/lsh-fixture.json) 的 1000 条真值向量

### 3. Schema 单一来源

- 所有结构定义在 `ops/adapters/schema-registry.json`
- Node / Python / TypeScript / Pydantic 派生器读它生成代码
- 改 schema 后必须跑 `node ops/adapters/generate-schemas.js --output types|zod|pydantic`
- CI `node ops/adapters/generate-schemas.js --check` 会失败如果派生过期

### 4. PowerShell 仅 Windows 优化

- `*.ps1` 是 Windows 启动 / 安装 / 卸载的用户面入口
- 跨平台逻辑（bus 核心、retrieval）必须在 Node/Python
- 避免 PS-only 高级语法（ternary / null-coalescing）以兼容 PS 5.1

### 5. 不引入重量级依赖

- 新增 `package.json` / `pyproject.toml` 依赖必须先在 PR 里说明：
  - 为什么 npm/PyPI 上现有包不行
  - 估计 bundle size / 安装时间影响
  - 是否有 no-dep 的轻量替代（首选 node:fs / Python stdlib）

### 6. 测试是 PR 的硬要求

- 新功能必须带测试（`tests/unit/js/` 或 `tests/unit/py/`）
- 修改 `bus/` 或 `retrieval/` 必须跑 `npm run test:all`
- 跨语言变更必须更新 `specs/lsh-fixture.json`（跑 `node _gen_fixture.js`）

---

## 模块分工

| 目录 | 语言 | 职责 |
|------|------|------|
| `bus/` | Node + PS | 记忆总线核心、文件 I/O、watchdog |
| `shared-mcp/` | Node | MCP server、29 个工具、tool-registry |
| `retrieval/` | Python | 检索、BM25、dense scoring、ANN 索引 |
| `ops/` | Node + PS | 运维、构建、导出、cascade 队列、迁移 |
| `cli/` | Node | 用户面 CLI 入口 |
| `scripts/` | Node + PS | 跨平台安装 / 启动 / 测试 |

---

## 提交规范（精简版）

```
<type>(<scope>): <中文一句话>

- 改动 1
- 改动 2

关联: <issue 或债项>
```

**type**: feat / fix / refactor / perf / test / docs / chore  
**scope**: bus / shared-mcp / retrieval / ops / cli / scripts / docs

示例：

```
feat(export): JSONL → Markdown 真相派生层 (EverOS 借鉴 PoC)

- 新建 ops/export/export-md.js
- 派生到 ~/.ai-memory/derived/ 给 Obsidian 直接消费
- 8 必填 + 2 可选 frontmatter 字段

关联: tech-debt-roadmap.md 债项 #E1
```

---

## 调试技巧

| 现象 | 入口 |
|------|------|
| MCP server 启动失败 | `~/.ai-memory/logs/crash-*.log` (按 ISO 时间戳) |
| 启动卡住 | `~/.ai-memory/logs/start-YYYY-MM-DD.log` |
| 单 server 错误 | `~/.ai-memory/logs/{server-id}.err.log` |
| JSONL 损坏 | `node ops/check/check-memory-integrity.js --strict` |
| 检索没结果 | `node ops/util/jsonl-stream.js < structured/shared-inbox.jsonl` 验证数据 |
| ANN 慢 | `python -c "from retrieval.ann_index import ANNIndex; print(ANNIndex.is_available())"` |

---

## AI agents 协作约定

- **多 agent 任务**：默认用 TaskCreate / subagent 拆分，独立 slice 优先并行
- **共享上下文**：把项目事实写进 `.agents/skills/<task>/NOTES.md`，其他 agent 可读
- **影响分析**：动 `bus/` 或 `shared-mcp/` 前，先用 gitnexus MCP（如果可用）跑 blast radius
- **诚实汇报**：测试失败就报告失败，不要掩盖；不确定就说不确定

---

## 禁止事项

- ❌ 直接 push 到 main（必须 PR 流程 + 至少 1 个 review）
- ❌ 删 `~/.ai-memory` 数据（即使是测试环境 —— 用 `AI_MEMORY_STORE=/tmp/test-store` 隔离）
- ❌ 在 `bus/` 写 fs 同步 API（必须 stream / async）
- ❌ 在 commit message 里出现 "tested locally" 这种含糊词（必须说"npm test 通过 N 个"）
- ❌ 给已废弃代码加新功能（先 review tech-debt-roadmap.md）

---

## 如何贡献

1. Fork 仓库
2. 从 `develop` 拉分支：`feature/<name>` / `fix/<name>` / `refactor/<name>`
3. 实现 + 测试
4. 跑 `npm run test:all` 全过
5. PR 到 `develop`（不是 `main`）
6. 等 CI 全过 + 1 个 review

详见 [CONTRIBUTING.md](../CONTRIBUTING.md)。
