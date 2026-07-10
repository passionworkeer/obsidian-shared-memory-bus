---
name: debt-audit
description: 审计项目技术债 + 生成差分报告 (增量 vs 上次 commit)
version: 1
tags: [quality, refactor, roadmap]
estimated_duration: 10min
inputs:
  - since: "'last tag' or 'last week' or '<commit SHA>' or 'all'"
outputs:
  - debt_items: list of { id, severity, file, line, description, suggested_fix }
  - summary: { total, critical, high, medium, low }
  - markdown_report: ready to commit
---

# Debt Audit · 技术债审计 + 差分报告工作流

## 用途

把审计维度的抽象条目**映射到具体代码位置**, 给 reviewer 一个可操作清单。
(原 docs/internal/tech-debt-roadmap.md 已私有化; 现以 `docs/PROJECT_AUDIT_*.md` 为单一审计来源。)

## 审计维度

| 维度 | 检查点 | 严重度映射 |
|------|--------|-----------|
| 文件行数 | `> 800 行` | medium → high (按函数集中度) |
| 圈复杂度 | 单函数 `> 10 分支` | high |
| 重复代码 | 相似度 `> 80%` 的 ≥ 2 文件 | medium |
| 未用导出 | `export` 但无 `import` | low |
| 测试覆盖 | `bus/` `retrieval/` `shared-mcp/` 新代码未测 | critical |
| 安全 | 硬编码 token / `eval` / `child_process` shell=true | critical |
| 性能 | 全量重建 / O(n²) 算法 / 无缓存的 I/O | medium |
| 文档 | 公共 API 缺 JSDoc / 命令行工具缺 `--help` | low |

## 流程

```
1. 选定审计范围 (since=<ref>)
2. git diff 范围
3. 维度扫描 (每个维度 = 一个并行 subagent)
4. 严重度投票 (3 票 ≥ 2 票为采纳)
5. 输出 markdown_report 到 `docs/PROJECT_AUDIT_<date>.md`
```

## 输出格式

```markdown
## 差分审计报告 (since v3.1.0)

| ID | 严重度 | 文件 | 行 | 描述 | 建议 |
|----|--------|------|----|----|------|
| D-007 | high | shared-mcp/foo.js | 234 | 重复的 try/catch 包装 | 抽 _withErrorBoundary helper |
| D-008 | medium | bus/bar.js | 89-150 | 60 行函数 5 个职责 | 拆 3 个子函数 |

总计: 12 项 (critical: 1, high: 3, medium: 5, low: 3)
```

## 调用方式

1. agent 收到 "审计项目技术债"
2. 跑 `git log --oneline -20` 找 since 锚点
3. 启多 subagent (每个维度一个)
4. 合并结果 + 加权评分
5. 写报告到 `docs/PROJECT_AUDIT_<date>.md` 顶部

## 反模式

- ❌ 全量审计 (不设范围) — 慢, 不可比对
- ❌ 把 low 项混进 critical 报告 — 评审被噪声淹没
- ❌ 不给"建议"只给"问题" — 行动成本高