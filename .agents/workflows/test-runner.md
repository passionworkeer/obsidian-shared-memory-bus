---
name: test-runner
description: 跑项目测试套件 (JS + Python + 跨语言), 失败时自动 narrow 到失败用例
version: 1
tags: [testing, ci, debugging]
estimated_duration: 5min
inputs:
  - target: "'all' or 'js' or 'py' or 'cross' or '<file path>'"
  - filter: 可选, 测试名关键字 (e.g. "lsh")
outputs:
  - pass_count, fail_count
  - on_failure: { failed_files, suggested_fix, repro_command }
---

# Test Runner · 测试套件执行 + 失败定位工作流

## 用途

跑项目测试并智能 narrow 失败范围。新手 agent 不用知道所有 npm script,
按 target 选最快路径; 失败时给出**最小复现**命令。

## 路由表

| target | 命令 | 适用 |
|--------|------|------|
| `all` | `npm run test:all` | PR 前 / 发版前 |
| `js` | `npm test` | 改 `bus/` `shared-mcp/` `ops/*.js` 后 |
| `py` | `npm run test:py` | 改 `retrieval/*.py` 后 |
| `cross` | `npm run test:cross` | 改 `bus/lsh-hash.js` 或 `retrieval/lsh_utils.py` 后 |
| `e2e` | `npm run test:e2e` | 改 MCP server / IPC 协议后 |
| `<file path>` | 自动推断 | 单文件快速验证 |

## 失败处理协议

跑完失败时**必须**输出:

```yaml
failed_files:
  - path: tests/unit/js/foo.test.js
    failed_tests:
      - "test_name: error message"
suggested_fix: |
  - 检查 X 文件
  - 跑最小复现: node --test tests/unit/js/foo.test.js
repro_command: "node --test tests/unit/js/foo.test.js"
```

## 跳过条件

如果 `target=all` 但 `node` / `python` 不可用, 报告能力缺失, **不要**静默跳过。

## 反模式

- ❌ 跑全测但只看了最后 5 行 (漏掉前面的失败)
- ❌ 失败后不 narrow 直接让用户自己看日志
- ❌ 跨语言测试发现 JS ≠ Py 时不更新 `specs/lsh-fixture.json`