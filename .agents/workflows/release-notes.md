---
name: release-notes
description: 从 git log + 已合并 PR 标题生成用户友好的 release notes
version: 1
tags: [release, communication, docs]
estimated_duration: 5min
inputs:
  - from: 上一个 tag (e.g. v3.1.0)
  - to: 当前 HEAD 或指定 SHA
outputs:
  - CHANGELOG_section: markdown ready to commit
  - tweet_thread: 5-7 条推文
  - blog_post_draft: 300-500 字
---

# Release Notes · 发版说明自动生成工作流

## 用途

从 `git log <from>..<to>` + PR labels 自动生成三层内容:
- CHANGELOG (开发者向, 详细)
- 推文串 (社区向, 抓眼球)
- 博客草稿 (深度用户向, 故事性)

## 分类映射

| commit type | CHANGELOG section | 推文基调 |
|-------------|-------------------|---------|
| feat | "新增功能" | ✨ |
| perf | "性能改进" | ⚡ |
| fix | "修复" | 🐛 |
| refactor | (不出现) | (不出现) |
| docs | (不出现) | (不出现) |
| test | (不出现) | (不出现) |
| chore | (不出现) | (不出现) |

## 输出模板

### CHANGELOG_section

```markdown
## [vX.Y.Z] - YYYY-MM-DD

### 新增功能
- feat(scope): 中文描述 (#PR)

### 性能改进
- perf(scope): 中文描述 (#PR)

### 修复
- fix(scope): 中文描述 (#PR)
```

### tweet_thread (5-7 条)

1. (hook) "Local AI Memory Bus v3.2.0 released 🚀"
2. (headline) "最大变化: 一句话"
3. (visual stat) "性能: 30× 加速 / 1400+ 测试"
4. (use case) "现在你可以: ..."
5. (CTA) "→ github.com/.../releases"

### blog_post_draft

```
# v3.2.0: <钩子标题>

(开场 1 段: 用户的痛)

## 这次解决了什么

(2-3 个 bullet, 配数据)

## 一个真实场景

(讲一个用户的 morning 故事)

## 怎么升级

(3 行命令)

## 下一步

(roadmap teaser)
```

## 反模式

- ❌ 把 refactor 写进 CHANGELOG (用户不在乎)
- ❌ 推文 8+ 条 (没人读)
- ❌ 博客用 emoji 刷屏