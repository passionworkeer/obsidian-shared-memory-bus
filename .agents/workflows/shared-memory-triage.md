---
name: shared-memory-triage
description: 处理一条新的 memory 事件, 判断应该落到 L0-L5 哪一层, 决定是否需要 promote / archive / split
version: 1
tags: [memory, promotion, lifecycle]
estimated_duration: 30s
inputs:
  - event: 单条 memory 事件 JSON (shared-inbox.jsonl 一行)
outputs:
  - decision: { layer, action, reason, followup (optional) }
  - updated_jsonl_line: 带有 promotion_metadata 的新行
---

# Shared Memory Triage · 记忆分层决策工作流

## 用途

新进来一条 memory 事件 (从 `~/.ai-memory/structured/shared-inbox.jsonl` 读一行),
按**内容寿命 + 用途 + 重要性**三维度判定:

1. 它属于 L0-L5 哪一层?
2. 是否要 promote 到更高层 (例如 session → durable)?
3. 是否要 archive (与已有 archive-manifest 重复)?
4. 是否要 split 成多条原子事实?

## 决策表

| 信号 | 判到 L? | 动作 |
|------|---------|------|
| "这个会话正在做的" / "我下一步要" | L1 Session | 保持, 7 天滚动 |
| "项目 X 的关键决策" / "架构选了 Y" | L2 Essential | promote → durable, 标 importance=high |
| "通用知识, 跨项目可复用" | L3 Durable | 直接 durable, 加 tags |
| "API 文档 / 第三方说明" | L4 Reference | 转 reference/, 不进向量空间 |
| "已被新条目替代" / "明显过期" | L5 Archive | 写 archive-manifest.jsonl |
| "只是一次性上下文" / "临时数字" | L1 | 保持, 自动 7 天后过期 |

## 流程

```
Read event
  ↓
[Step 1] 检测内容寿命信号
  - 包含"今天/刚才/最近" → L1
  - 包含"项目 X 的架构/选型/约定" → L2+
  ↓
[Step 2] 查重 (与 durable/ 参考已有条目)
  - 重复 → L5 archive (写 tombstone)
  ↓
[Step 3] 评估是否需要 promote
  - 跨工具使用率 ≥ 3 → 强制 promote
  - 重要性 ≥ high + 用户标记 → 强制 promote
  ↓
[Step 4] 输出 decision
  - { layer, action: 'keep'|'promote'|'archive'|'split', reason, followup? }
```

## 调用方式

任何 agent 收到 "处理这条 memory" 的请求时:

1. 读 `~/.ai-memory/structured/shared-inbox.jsonl` 取最新未处理行
2. 套决策表
3. 写回 `promotion_metadata` 字段
4. 移到目标层对应 JSONL 文件

## 反模式

- ❌ 把用户的 "今天晚饭" 提升到 L3 Durable (噪声污染)
- ❌ 把架构决策放到 L1 (7 天后被自动删除, 关键决策丢失)
- ❌ 不查重直接 promote (重复条目, 浪费向量空间)