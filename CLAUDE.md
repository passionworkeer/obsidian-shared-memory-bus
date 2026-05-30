# 项目规范 / Project Standards

## 分支策略 (Git Flow)

```
main        ← 稳定版本，production可运行，语义化tag
  │
  └── develop ← 开发主分支，日常开发基础分支
        ├── feature/*    ← 功能分支，从develop创建
        ├── release/*    ← 发布分支，从develop创建
        └── bugfix/*     ← bug修复，从develop创建

hotfix/*    ← 热修复分支，从main创建，修复后合并到main和develop
```

## 开发流程

### 1. 功能开发

```bash
# 从develop创建功能分支
git checkout develop
git pull origin develop
git checkout -b feature/your-feature develop

# 开发完成后，合并到develop
git checkout develop
git merge --no-ff feature/your-feature
git push origin develop

# 删除已合并的分支
git branch -d feature/your-feature
```

### 2. 发布流程

```bash
# 从develop创建release分支
git checkout -b release/v1.x.0 develop

# 完成发布
git checkout main
git merge --no-ff release/v1.x.0
git tag -a v1.x.0 -m "Release v1.x.0"
git push origin main --tags

# 合并回develop
git checkout develop
git merge --no-ff release/v1.x.0
git push origin develop
```

### 3. 热修复

```bash
# 从main创建hotfix
git checkout -b hotfix/v1.x.1 main

# 修复后合并到main和develop
git checkout main && git merge --no-ff hotfix/v1.x.1 && git tag -a v1.x.1 -m "Hotfix v1.x.1" && git push origin main --tags
git checkout develop && git merge --no-ff hotfix/v1.x.1 && git push origin develop
```

## 代码规范

### 提交信息 (Conventional Commits)

```
feat: 新功能
fix: 修复问题
docs: 文档变更
refactor: 重构
perf: 性能优化
test: 测试相关
chore: 构建/工具变更
```

### 代码质量

- 函数 < 50行
- 文件 < 800行
- 无深层嵌套 (>4层)
- 使用不可变模式
- 输入验证在系统边界

## 项目结构

```
bus/           ← 核心总线模块
cli/           ← 命令行工具
ops/           ← 操作脚本
  ├── build/   ← 构建相关
  ├── memory/  ← 记忆层
  ├── mcp/     ← MCP工具
  └── ...
retrieval/     ← 检索模块
tests/         ← 测试
```

## 测试要求

- 新功能需有测试
- 提交前运行: `npm test`
- 覆盖率达到 80%+

## 版本规范

语义化版本 (semver.org):
- MAJOR: 不兼容的API变更
- MINOR: 向后兼容的功能新增
- PATCH: 向后兼容的问题修复

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **obsidian-shared-memory-bus** (7936 symbols, 12938 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/obsidian-shared-memory-bus/context` | Codebase overview, check index freshness |
| `gitnexus://repo/obsidian-shared-memory-bus/clusters` | All functional areas |
| `gitnexus://repo/obsidian-shared-memory-bus/processes` | All execution flows |
| `gitnexus://repo/obsidian-shared-memory-bus/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
