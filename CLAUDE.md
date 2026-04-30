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