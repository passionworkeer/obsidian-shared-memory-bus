# 开发流程 / Development Workflow

## 分支策略 / Branch Strategy

```
main        ← 稳定版本，只接受 release/hotfix 合并，语义化 tag (v1.0.0)
  │
  ├── develop ← 开发主分支，日常开发的基础分支
  │     ├── feature/*  ← 功能分支，从 develop 创建
  │     └── release/*  ← 发布分支，从 develop 创建
  │
  └── hotfix/*  ← 热修复分支，从 main 创建
```

## 分支职责 / Branch Responsibilities

| 分支 | 用途 | 合并来源 | 合并目标 |
|------|------|---------|---------|
| `main` | 稳定可运行版本 | release, hotfix | - |
| `develop` | 集成分支 | feature, release | main |
| `feature/*` | 单个功能开发 | - | develop |
| `release/*` | 发布准备 | develop | main, develop |
| `hotfix/*` | 紧急修复 | - | main, develop |

## 开发流程 / Development Flow

### 日常开发

```bash
# 1. 确保在 develop 分支
git checkout develop
git pull origin develop

# 2. 创建功能分支
git checkout -b feature/your-feature develop

# 3. 开发完成后，合并到 develop
git checkout develop
git merge --no-ff feature/your-feature
git push origin develop

# 4. 删除已合并的功能分支
git branch -d feature/your-feature
```

### 发布流程 / Release Flow

```bash
# 1. 从 develop 创建 release 分支
git checkout -b release/v1.1.0 develop

# 2. 完成发布准备后，合并到 main 并打 tag
git checkout main
git merge --no-ff release/v1.1.0
git tag -a v1.1.0 -m "Release v1.1.0"
git push origin main --tags

# 3. 合并回 develop
git checkout develop
git merge --no-ff release/v1.1.0
git push origin develop

# 4. 删除 release 分支
git branch -d release/v1.1.0
```

### 热修复流程 / Hotfix Flow

```bash
# 1. 从 main 创建 hotfix 分支
git checkout -b hotfix/v1.0.1 main

# 2. 修复后合并到 main 和 develop
git checkout main
git merge --no-ff hotfix/v1.0.1
git tag -a v1.0.1 -m "Hotfix v1.0.1"
git push origin main --tags

git checkout develop
git merge --no-ff hotfix/v1.0.1
git push origin develop

# 3. 删除 hotfix 分支
git branch -d hotfix/v1.0.1
```

## 版本规范 / Version Convention

使用[语义化版本](https://semver.org/lang/zh-CN/)：

- **MAJOR.MINOR.PATCH** (如 v1.2.3)
- MAJOR: 不兼容的API变更
- MINOR: 向后兼容的功能新增
- PATCH: 向后兼容的问题修复

## 提交规范 / Commit Convention

参考 [Conventional Commits](https://www.conventionalcommits.org/)：

```
feat: 新功能
fix: 修复问题
docs: 文档变更
style: 代码格式（不影响功能）
refactor: 重构
perf: 性能优化
test: 测试相关
chore: 构建/工具变更
```

## 分支保护 / Branch Protection

- `main` 分支受保护，需要 PR 才能合并
- 所有合并使用 `--no-ff` 保留分支历史
- CI 测试通过后才能合并到 main

## 当前里程碑 / Current Milestones

| Tag | 版本 | 说明 |
|-----|------|------|
| v0.1.0 | 初始化 | Initial public bundle |
| v0.2.0 | 优化 | 一键安装优化 |
| v0.3.0 | 架构 | 内存架构改进 |
| v0.4.0 | 生产级 | 熔断器、自适应搜索 |
| v1.0.0 | 正式版 | npm start 支持 |