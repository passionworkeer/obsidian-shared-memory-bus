# obsidian-shared-memory-bus · 技术债修复 Roadmap（v2 详细版）

> **版本**：v2.0（详细版）
> **撰写日期**：2026-06-17
> **当前代码状态**：v3.1.0，~6.9 万行，跨 PS/Node/Py 三语言 309 文件
> **目标**：在 6 个月内把可维护性 / 可靠性 / 可移植性提升一个台阶，**不破坏现有用户**
> **v1 → v2 增补**：每个债项加 ASCII 架构图、目标代码骨架、PR 拆分清单、回滚 checklist、风险登记表、完整脚本骨架

---

## 0. 现状速览

| 维度 | 现状 | 健康分（10 分制） | 6 月后目标 |
|---|---|---|---|
| **测试覆盖率** | 50+ 测试文件，但未统计行覆盖率，估计 JS 端 30-40% / Py 端 20-30% | 5/10 | 8/10 |
| **构建/部署** | 9 个 MCP 服务 + PowerShell 启动链，无统一打包 | 3/10 | 8/10 |
| **类型安全** | 无 TypeScript，无 Pydantic，全靠 JSON Schema 校验 | 3/10 | 7/10 |
| **文档** | 37 篇 MD，但分散在 8 个目录，缺少导航站 | 6/10 | 9/10 |
| **可移植性** | Win 深度覆盖，macOS/Linux 实战少 | 5/10 | 8/10 |
| **代码重复** | PS/Node/Py 三端 LSH 算法需手同步 | 4/10 | 8/10 |
| **CI 成熟度** | 7 个 workflow 但未测真实矩阵 | 5/10 | 9/10 |
| **贡献者** | 1 人（作者） | 1/10 | 6/10 |
| **文档站点** | 无 | 2/10 | 9/10 |
| **安装摩擦** | 5-10 步手工 | 2/10 | 8/10 |

**核心矛盾**：项目已经具备一个完整产品应有的所有模块（数据/检索/桥接/控制/监控），但**工程化成熟度落后于功能完整度**。这种状态下继续堆功能，bug 率会指数上升。

---

## 1. 7 个核心债项的详细解剖

### 债项 #1 · `omni-memory-server.js` 是 1500+ 行的 God Server 【P0】

**当前已确认信息**（基于源码抓取）：
- 文件路径：`/shared-mcp/omni-memory-server.js`
- **实际行数：1447 行**（精确数）
- 启动方式：`npm start` → `node start.js` → 调起此 server
- 导入的子模块：`memory-retrieval.js` / `memory-generation.js` / `memory-bridge.js` / `memory-status.js` / `memory-embeddings.js` / `memory-tools.js`（TOOLS 常量）/ `ipc-protocol.js` / `health-check.js`
- 监控：引入 `metrics/structured-logger.js` + `metrics/trace-manager.js`
- 环境变量管理：15+ 个 `AI_MEMORY_*` 变量在 `WINDOWS_ENV_CACHE` 中缓存

#### 1.1 架构图（拆分前 vs 拆分后）

**拆分前**（当前 1447 行单体）：

```
┌──────────────────────────────────────────────────────┐
│           omni-memory-server.js (1447 行)            │
│  ┌──────────┬──────────┬──────────┬─────────────┐     │
│  │Manifest  │IPC      │HTTP     │Structured  │     │
│  │加载      │Protocol │Proxy    │Logger      │     │
│  ├──────────┼──────────┼──────────┼─────────────┤     │
│  │子进程    │Embedding│Health   │Trace       │     │
│  │Spawn     │Worker   │Check    │Manager     │     │
│  ├──────────┼──────────┼──────────┼─────────────┤     │
│  │Python    │Prometheus│Config  │MCP Server  │     │
│  │检索      │Metrics  │Parser   │主循环      │     │
│  └──────────┴──────────┴──────────┴─────────────┘     │
│  32 个 MCP 工具注册在同一个进程里                       │
└──────────────────────────────────────────────────────┘
```

**拆分后**（4 个独立 server，进程隔离）：

```
┌────────────────────┐  ┌────────────────────┐
│omni-memory-         │  │omni-memory-         │
│retrieval-server     │  │bridge-server        │
│(端口 9338)          │  │(端口 9339)          │
│                     │  │                     │
│  memory_status      │  │  claude-mem 桥接    │
│  search_shared      │  │  blackboard 桥接    │
│  get_records        │  │  import_from_claude │
│                     │  │  export_to_obsidian │
└────────────────────┘  └────────────────────┘
        ↑                        ↑
        │ 共享 ~/.ai-memory/      │
        │ SQLite + JSONL          │
        │                        │
┌────────────────────┐  ┌────────────────────┐
│omni-memory-         │  │omni-memory-         │
│dream-server         │  │mgmt-server          │
│(端口 9340)          │  │(端口 9341)          │
│                     │  │                     │
│  async_promote      │  │  list_embedding_    │
│  async_archive      │  │  runtimes           │
│  nightly_dream      │  │  set_embedding_     │
│  integrity_check    │  │  runtime            │
│                     │  │  rebuild_index      │
└────────────────────┘  └────────────────────┘
```

#### 1.2 拆分方案（4 个 PR 顺序）

**PR-1.1 · 提取 manifest + config 加载层**
- 从 `omni-memory-server.js` 抽出 `manifest-loader.js`（≤ 200 行）
- 仅依赖：`fs`、`path`、项目内 `runtime-config.js`
- 测试：`tests/unit/shared-mcp/manifest-loader.test.js`
- 验收：所有 manifest 字段都从 `manifest-loader.js` 单点获取

**PR-1.2 · 提取健康检查 + IPC 代理层**
- 抽出 `mcp-process-manager.js`（≤ 250 行）
- 负责：spawn 4 个子 server、监控健康、按需重启
- 测试：`tests/integration/shared-mcp/process-manager.test.js`
- 验收：4 个 server 启动顺序可控、独立崩溃可恢复

**PR-1.3 · 拆分 server 主体为 4 个文件**
- 拆出 `omni-memory-retrieval-server.js`（≤ 350 行）
- 拆出 `omni-memory-bridge-server.js`（≤ 250 行）
- 拆出 `omni-memory-dream-server.js`（≤ 300 行）
- 拆出 `omni-memory-mgmt-server.js`（≤ 280 行）
- 同步更新 `shared-mcp/manifest.json` 端口分配
- 测试：每个 server 独立 `npm test:unit` 通过

**PR-1.4 · 兼容层 + 文档**
- 保留 `omni-memory-server.js` 作为"all-in-one"兼容入口（≤ 100 行）
- 新用户走 4 个独立 server；旧用户继续用兼容层
- 文档：`docs/architecture/SERVER-SPLIT.md`

#### 1.3 目标代码骨架（`omni-memory-retrieval-server.js` 示例）

```javascript
// shared-mcp/omni-memory-retrieval-server.js
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMemoryRetrieval } from "./memory-retrieval.js";
import { createStructuredLogger } from "./metrics/structured-logger.js";

const TOOLS_FOR_THIS_SERVER = [
  "memory_status",
  "search_shared_memory",
  "get_memory_records",
  "list_projects",
];

export async function startRetrievalServer({ port = 9338 } = {}) {
  const log = createStructuredLogger("retrieval-server");
  const server = new Server(
    { name: "omni-memory-retrieval", version: "3.2.0" },
    { capabilities: { tools: {} } }
  );
  const retrieval = await createMemoryRetrieval();

  server.setRequestHandler("tools/list", async () => ({
    tools: TOOLS_FOR_THIS_SERVER.map((name) => RETRIEVAL_TOOL_DEFS[name]),
  }));

  server.setRequestHandler("tools/call", async (req) => {
    const { name, arguments: args } = req.params;
    log.info("tool_call", { name, args });
    return await retrieval.handle(name, args);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("started", { port });
}
```

#### 1.4 回滚 Checklist

- [ ] 保留 git tag `v3.1.0-monolith`（拆分前的最后一个 commit）
- [ ] 兼容层 `omni-memory-server.js` 永不删除
- [ ] manifest.json 保留 `"compatibility_mode": true` 字段
- [ ] README 标注"独立 server 是默认，monolithic 是兼容模式"
- [ ] CI 跑两套测试（拆分版 + monolithic）

**总工时**：1 名工程师 3 周
**风险等级**：中（向后兼容 + 端口规划 + 文档）

---

### 债项 #2 · LSH 算法在 JS / Python 双端实现，需手同步 【P0】

#### 2.1 当前问题确认

- JS 端：`bus/lsh-hash.js`（FNV-1a32 实现）
- Py 端：`retrieval/lsh_utils.py`（同样 FNV-1a32 实现）
- 跨语言测试：`tests/cross-language/`（唯一保险）
- 风险：FNV 参数改一处，另一端忘记改 → hash 失配 → 索引全量重建

#### 2.2 解决方案 4 步走

| 步骤 | 方案 | 工时 | 风险 |
|---|---|---|---|
| **A. 真值向量** | 把 FNV-1a32 改为从 `specs/lsh-fixture.json` 读取测试向量 | 2 天 | 低 |
| **B. 单端权威** | 选 JS 端为权威，Py 端改为 `subprocess.check_output(['node', 'lsh-hash.js', text])` 调起 | 1 周 | 中（启动多 50ms） |
| **C. 跨语言测试** | 1000 条随机文本 × 2 端 hash 比对，作为 CI 强制门禁 | 2 天 | 低 |
| **D. 协议文档** | `docs/specs/lsh-protocol.md` 固化版本号、输入输出、变更流程 | 1 天 | 低 |

#### 2.3 `docs/specs/lsh-protocol.md` 模板

```markdown
# LSH Hash Protocol v1.2

## 输入
- 字符串（任意 UTF-8）
- 可选：normalize（默认 true，转小写去标点）

## 输出
- 16 位 LSH 签名（4 个 uint32 槽位 → 拼接 16 字符 hex 字符串）
- 长度固定：16 hex chars

## 算法
- 基础：FNV-1a 32-bit
- 切分：按 unigram + bigram
- 窗口：5-gram
- 桶数：64

## 版本兼容性
- v1.0 初始版本
- v1.1 增加 normalize 开关
- v1.2 输出格式改为 hex 字符串
- 破坏性变更必须 bump major version

## 升级流程
1. 在 specs/lsh-fixture.json 增 1000 条 fixture
2. 双端 PR 同时改 + 同步版本号
3. CI 跑 `npm run test:cross` 必须 0 失配
4. 发 v3.x.0 minor，CHANGELOG 标 BREAKING-LIKE-CHANGE
```

#### 2.4 `tests/cross-language/lsh-equivalence.test.js` 骨架

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { lshHash } from "../../bus/lsh-hash.js";
import { execFileSync } from "node:child_process";

const FIXTURE_PATH = "specs/lsh-fixture.json";
const PYTHON_SCRIPT = "retrieval/_lsh_subprocess.py";

test("1000 fixtures: JS and Python produce identical LSH signatures", () => {
  const fixtures = JSON.parse(
    execFileSync("cat", [FIXTURE_PATH]).toString()
  );

  let mismatches = 0;
  const mismatchDetails = [];

  for (const { text, expected } of fixtures) {
    const jsResult = lshHash(text);
    const pyResult = execFileSync("python3", [
      PYTHON_SCRIPT, "hash", text,
    ]).toString().trim();

    if (jsResult !== pyResult || jsResult !== expected) {
      mismatches++;
      mismatchDetails.push({ text, jsResult, pyResult, expected });
    }
  }

  if (mismatches > 0) {
    console.error("Mismatches:", mismatchDetails.slice(0, 5));
  }
  assert.equal(mismatches, 0, `${mismatches}/${fixtures.length} fixtures mismatched`);
});
```

#### 2.5 Py 端 subprocess 桥接代码

```python
# retrieval/_lsh_subprocess.py
import sys
import json
import argparse

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["hash", "version"])
    parser.add_argument("text", nargs="?", default="")
    args = parser.parse_args()

    if args.command == "version":
        print(json.dumps({"version": "1.2", "impl": "node-subprocess"}))
        sys.exit(0)

    import subprocess
    result = subprocess.check_output(
        ["node", "bus/lsh-hash.js", "--text", args.text],
        cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    )
    print(result.decode().strip())

if __name__ == "__main__":
    main()
```

#### 2.6 升级流程图

```
1. 修改 bus/lsh-hash.js
   ↓
2. 本地跑 npm run test:cross
   ↓
3. 失配？→ 同步改 retrieval/lsh_utils.py → 回到 1
   ↓
4. 0 失配？→ 更新 specs/lsh-fixture.json → bump version
   ↓
5. PR 标题: "feat(lsh): add normalize=optional (v1.2)"
   ↓
6. CI 全绿 → merge → 发 v3.x.0
```

**总工时**：2 周
**风险等级**：中（启动延迟 + 版本号同步）

---

### 债项 #3 · 内存契约是 JSON Schema + 手写校验，缺类型生成 【P1】

#### 3.1 当前架构

```
ops/adapters/schema-registry.json  ← 真值源
        ↓
ops/adapters/generate-schemas.js   ← 推断生成器
        ↓
├─ shared-mcp/validators/*.js     ← JS 端校验器
├─ retrieval/validators/*.py      ← Py 端校验器
└─ 文档/README（手写，落后于代码）
```

**问题**：生成的代码只是运行期校验器，IDE 无法补全。

#### 3.2 目标架构

```
ops/adapters/schema-registry.json  ← 真值源
        ↓
ops/adapters/generate-schemas.js   ← 增强版生成器
        ↓
├─ shared-mcp/types/*.d.ts         ← TypeScript 类型声明
├─ shared-mcp/validators/*.js      ← Zod runtime 校验
├─ retrieval/types/*.py            ← Pydantic 类
├─ retrieval/validators/*.py       ← 复用 Pydantic
└─ docs/api/types.md               ← 自动生成
```

#### 3.3 `generate-schemas.js` 增强版骨架

```javascript
// ops/adapters/generate-schemas.js
import fs from "node:fs";
import path from "node:path";
import { compile } from "json-schema-to-typescript";
import { z } from "zod";

const REGISTRY = "ops/adapters/schema-registry.json";
const OUT = {
  ts: "shared-mcp/types/",
  py: "retrieval/types/",
  zod: "shared-mcp/validators/",
  pydantic: "retrieval/validators/",
  doc: "docs/api/types.md",
};

async function main() {
  const registry = JSON.parse(fs.readFileSync(REGISTRY, "utf-8"));

  for (const [name, schema] of Object.entries(registry.definitions)) {
    // 1. TypeScript
    const tsContent = await compile(schema, name, {
      bannerComment: `/* eslint-disable */\n// Auto-generated from schema-registry.json\n// Do not edit manually`,
    });
    fs.writeFileSync(path.join(OUT.ts, `${name}.d.ts`), tsContent);

    // 2. Zod (JS 端 runtime 校验)
    const zodCode = generateZodFromSchema(schema, name);
    fs.writeFileSync(path.join(OUT.zod, `${name}.js`), zodCode);

    // 3. Pydantic (Py 端)
    const pydanticCode = generatePydanticFromSchema(schema, name);
    fs.writeFileSync(path.join(OUT.pydantic, `${name}.py`), pydanticCode);
  }

  // 4. 文档
  fs.writeFileSync(OUT.doc, generateTypeDoc(registry.definitions));
  console.log(`✓ Generated ${Object.keys(registry.definitions).length} type definitions`);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

#### 3.4 使用示例（迁移后）

```javascript
// shared-mcp/omni-memory-retrieval-server.js (迁移后)
import { MemoryRecordSchema } from "./validators/memory-record.js";
import type { MemoryRecord } from "./types/memory-record.js";

async function handleSearch(args: { query: string; limit?: number }): Promise<MemoryRecord[]> {
  // IDE 补全 ✓
  // 类型错误在 lint 阶段暴露 ✓
  // 运行期校验由 Zod 保证 ✓
  const records = await retrieval.search(args);
  return records.map(r => MemoryRecordSchema.parse(r));  // 二次校验
}
```

#### 3.5 验收 Checklist

- [ ] `bun run gen:types` 一键生成全部
- [ ] `git grep "memory_record\."` 能 IDE 补全
- [ ] 改 schema-registry.json 后 `gen:types` 自动重生成
- [ ] Pydantic + Zod 端 1000 条随机样本 0 失配
- [ ] CHANGELOG 标 "feat: add auto-generated TypeScript types"

**总工时**：2 周
**风险等级**：低（双轨期 1 个 minor 版本）

---

### 债项 #4 · PowerShell 启动链复杂，Windows console 隐藏 3 层 shim 【P1】

#### 4.1 当前 shim 链

```
Claude Desktop
    ↓ 调起
shared-mcp/start-shared-mcp.ps1
    ↓ PowerShell Hidden
shared-mcp/singleton-stdio-mcp-proxy.mjs
    ↓ 调起（隐藏窗口）
VBS script (临时生成)
    ↓ spawn
npx / python 子进程
```

**问题**：
- PowerShell 5.1 vs 7 行为差异
- 不同 Node 版本对 stdio 处理不同
- uvx vs python 启动器行为不同
- **失败时用户看到空白窗口**，无任何错误信息

#### 4.2 重构方案

**目标**：去 PowerShell Hidden，改为 detached process + 错误日志

**实现**：
```powershell
# shared-mcp/start-shared-mcp.ps1 (v2)
$ErrorActionPreference = "Stop"
$LogDir = Join-Path $env:USERPROFILE ".ai-memory\logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LogFile = Join-Path $LogDir "start-$(Get-Date -Format 'yyyyMMdd').log"

try {
    $nodeArgs = @("shared-mcp/omni-memory-server.js")
    $process = Start-Process -FilePath "node" `
        -ArgumentList $nodeArgs `
        -WindowStyle Hidden `
        -RedirectStandardOutput $LogFile `
        -RedirectStandardError "$LogFile.err" `
        -NoNewWindow -PassThru

    Write-Host "Started PID=$($process.Id), logs at $LogFile"
}
catch {
    Add-Content -Path $LogFile -Value "START FAILED: $_"
    Write-Host "Failed to start. See: $LogFile"
    exit 1
}
```

#### 4.3 错误日志约定

`~/.ai-memory/logs/` 目录结构：
```
logs/
├── install-2026-06-17.log          # 安装日志
├── start-2026-06-17.log            # 启动日志（按天）
├── start-2026-06-17.log.err        # stderr
├── runtime-2026-06-17.log          # 运行日志（trace + structure log）
└── crash-2026-06-17T18-30-12.log   # 崩溃日志（带 stack）
```

#### 4.4 降级方案

如果用户用的是 PowerShell 5.1（Windows 默认）：
- 保留旧 shim 作为 fallback
- `scripts/check-ps-version.ps1` 检测后自动选路径
- 文档说明 PowerShell 7 推荐（Microsoft Store 一键装）

**总工时**：1.5 周
**风险等级**：中（Windows 兼容性是核心用户痛点）

---

### 债项 #5 · 检索偏本地简单实现，扩展性差 【P1】

#### 5.1 当前实现

- BM25 词频打分（`bus/bm25.js`）
- Dense vector 余弦相似度（`retrieval/embedding_providers.py`）
- MMR 重排序去冗余
- Temporal decay（时间衰减）
- **全内存计算，无 ANN 索引**

#### 5.2 性能基线（待压测）

| 数据量 | BM25 单独 | Dense 单独 | 混合 P95 | 内存占用 |
|---|---|---|---|---|
| 1K | <10ms | <50ms | <60ms | ~50MB |
| 10K | <30ms | <200ms | <250ms | ~200MB |
| 50K | <100ms | <800ms | <1000ms | ~1GB |
| 100K | <200ms | <1500ms | <2000ms | ~2GB |

**瓶颈**：Dense 余弦在 50K+ 时 O(N·d) 计算量爆炸

#### 5.3 渐进式 ANN 方案

**Phase 1（1 周）**：可选 ANN
- 引入 `hnswlib`（Py 端）
- 新增 CLI flag `--use-ann`（opt-in）
- 默认行为不变

**Phase 2（1 周）**：自动选择
- 数据量 > 10K 时自动切到 ANN
- 保持 BM25 全量 + Dense ANN 的混合策略
- 性能日志埋点

**Phase 3（1 周）**：streaming 返回
- 大结果集分批返回
- 减少单次响应 latency

#### 5.4 关键代码骨架

```python
# retrieval/ann_index.py
import numpy as np
from typing import List, Optional
import hnswlib

class ANNIndex:
    def __init__(self, dim: int, max_elements: int = 100_000):
        self.index = hnswlib.Index(space="cosine", dim=dim)
        self.index.init_index(
            max_elements=max_elements,
            ef_construction=200,
            M=16,
        )
        self.index.set_ef(50)  # 查询时精度

    def add(self, vectors: np.ndarray, ids: List[int]):
        self.index.add_items(vectors, ids)

    def search(self, query: np.ndarray, k: int = 10) -> List[tuple]:
        labels, distances = self.index.knn_query(query, k=k)
        return list(zip(labels[0].tolist(), distances[0].tolist()))

    def save(self, path: str):
        self.index.save_index(path)

    def load(self, path: str):
        self.index.load_index(path)
```

#### 5.5 验收标准

- [ ] 100K embeddings 下，BM25+dense 混合查询 P95 <300ms
- [ ] ANN 模式 P95 <100ms
- [ ] 内存占用 <500MB
- [ ] 向后兼容：默认行为不变
- [ ] 文档说明何时该开 ANN

**总工时**：3 周
**风险等级**：中（Py 端依赖 + 索引持久化）

---

### 债项 #6 · typed promotion 仍是启发式，未 benchmark 校准 【P2】

#### 6.1 当前启发式（推断）

```javascript
// shared-mcp/memory-generation.js（推断）
async function promoteToTier(record, currentTier) {
  const confidence = record.confidence || 0;
  const sessions = record.session_count || 1;

  if (currentTier === "event" && confidence >= 0.5) return "session";
  if (currentTier === "session" && sessions >= 3) return "project";
  if (currentTier === "project" && confidence >= 0.7) return "shared";
  if (currentTier === "shared" && record.age_days > 90) return "archive";
  return currentTier;
}
```

**问题**：
- 阈值是 hand-tuned
- 无 ground truth
- 误判/漏判无指标

#### 6.2 修复路径（4 PR）

**PR-6.1 · 准备评测数据集**
- 收集 200+ 真实 memory record
- 手工标注"应该属于哪个 tier"
- 存到 `tests/fixtures/promotion-judgments.jsonl`
- 标注规则文档化（`docs/specs/promotion-annotation-guide.md`）

**PR-6.2 · 评测脚本**
- `ops/eval/promotion-eval.py`
- 输入：`promotion-judgments.jsonl` + 启发式算法
- 输出：precision / recall / F1 / 混淆矩阵
- 写一份 baseline report

**PR-6.3 · 阈值校准**
- 用 grid search 找最优阈值
- precision ≥ 0.8 / recall ≥ 0.7 才接受
- 写 `docs/specs/promotion-thresholds-v2.md`

**PR-6.4 · CI 门禁**
- 在 `.github/workflows/eval-promotion.yml` 加评测
- 阈值回退 ≥5% 时 fail
- 每周日自动跑

#### 6.3 评测脚本骨架

```python
# ops/eval/promotion-eval.py
import json
from pathlib import Path
from sklearn.metrics import precision_recall_fscore_support, confusion_matrix

FIXTURE = Path("tests/fixtures/promotion-judgments.jsonl")
TIERS = ["event", "session", "project", "shared", "archive"]

def load_judgments():
    with FIXTURE.open() as f:
        return [json.loads(line) for line in f]

def predict_tier(record, thresholds):
    """复现启发式，但用可调阈值"""
    # ... 同 6.1 启发式结构
    pass

def main():
    judgments = load_judgments()
    y_true, y_pred = [], []
    for j in judgments:
        y_true.append(j["expected_tier"])
        y_pred.append(predict_tier(j["record"], thresholds=THRESHOLDS))

    p, r, f, _ = precision_recall_fscore_support(y_true, y_pred, labels=TIERS, average="macro")
    cm = confusion_matrix(y_true, y_pred, labels=TIERS)
    print(f"Macro P/R/F1: {p:.3f} / {r:.3f} / {f:.3f}")
    print("Confusion matrix (rows=true, cols=pred):")
    print(cm)

    assert p >= 0.8, f"precision {p:.3f} < 0.8"
    assert r >= 0.7, f"recall {r:.3f} < 0.7"

if __name__ == "__main__":
    main()
```

**总工时**：2 周
**风险等级**：低（独立模块，可灰度）

---

### 债项 #7 · macOS / Linux 实战少，install/validate 脚本未充分压测 【P2】

#### 7.1 当前 CI 矩阵

仅 ubuntu-latest + Python 3.11（基于抓取的 `eval-routing.yml` 推断）

#### 7.2 目标 CI 矩阵

```yaml
# .github/workflows/cross-platform.yml
name: Cross Platform CI
on:
  pull_request:
  push:
    branches: [main]

jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-13, macos-14, macos-15, windows-2022, windows-2025]
        node: [20, 22, 24]
        python: ["3.10", "3.11", "3.12"]
        exclude:
          - os: windows-2025
            python: "3.10"
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: ${{ matrix.node }} }
      - uses: actions/setup-python@v5
        with: { python-version: ${{ matrix.python }} }
      - run: npm ci
      - run: npm run test:all
      - run: bash scripts/install.sh --smoke-test
      - run: bash scripts/start.sh && curl localhost:9338/health
```

#### 7.3 macOS 特定修复清单

- [ ] `~/Library/Application Support` 路径处理
- [ ] LaunchAgent plist 生成（`~/Library/LaunchAgents/com.ai-memory.bus.plist`）
- [ ] `security` keychain 集成（如果用 secure storage）
- [ ] Apple Silicon (`/opt/homebrew`) vs Intel (`/usr/local`) 路径分支

#### 7.4 Linux 特定修复清单

- [ ] `systemd --user` 集成（`~/.config/systemd/user/ai-memory-bus.service`）
- [ ] XDG Base Directory 规范
- [ ] `pip` vs `pipx` vs `uv` 启动器
- [ ] SELinux / AppArmor 兼容性

**总工时**：2 周
**风险等级**：低（CI 工具完善 + 修边角）

---

## 2. 优先级矩阵

```
        影响 ↑
            │
   P0-#1    │   P0-#2 LSH 同步
   God      │   P1-#3 类型生成
   Server   │
            │   P1-#4 PS 启动链
            │   P1-#5 检索扩展
            │
   P2-#6   │   P2-#7 跨平台
  promotion │   CI 矩阵
  校准      │
            │
            └──────────────────────→ 工时
              短          中        长
```

| 优先级 | 债项 | 工时 | 风险 | 价值 | 启动周 |
|---|---|---|---|---|---|
| **P0** | #1 God Server 拆分 | 3 周 | 中 | 极高 | W1 |
| **P0** | #2 LSH 跨语言同步 | 2 周 | 中 | 高 | W2 |
| **P1** | #3 类型生成 | 2 周 | 低 | 高 | W3 |
| **P1** | #4 Windows 启动链 | 1.5 周 | 中 | 中 | W5 |
| **P1** | #5 ANN 检索 | 3 周 | 中 | 中 | W6 |
| **P2** | #6 promotion 校准 | 2 周 | 低 | 中 | W10 |
| **P2** | #7 跨平台 CI | 2 周 | 低 | 中 | W12 |
| **合计** | | **15.5 周** | | | |

**总工时**：15.5 周（1 人全职 ≈ 4 个月）

---

## 3. 阶段路线图（逐周 PR 拆分）

### Phase 1：基础稳固（W1-W8 / Q3 2026 · 7-9 月）

**目标**：消除 God Server + 跨语言同步债，让 1 人也能安心改代码

| 周次 | PR 标题 | 主要工作 | 工时 | 验收 |
|---|---|---|---|---|
| **W1** | `refactor: extract manifest-loader.js` | 提取 manifest 加载层 | 1d | 独立单测 |
| **W1** | `refactor: extract mcp-process-manager.js` | 提取进程管理 | 3d | 启动/恢复测试 |
| **W2** | `refactor: split omni-memory-retrieval-server` | 拆出 retrieval server | 3d | 单一文件 ≤ 400 行 |
| **W2** | `refactor: split omni-memory-bridge-server` | 拆出 bridge server | 2d | 单测通过 |
| **W3** | `refactor: split omni-memory-dream-server` | 拆出 dream server | 2d | 单测通过 |
| **W3** | `refactor: split omni-memory-mgmt-server` | 拆出 mgmt server | 2d | 单测通过 |
| **W4** | `refactor: keep omni-memory-server.js as compat layer` | 兼容层 | 1d | 旧调用方式仍工作 |
| **W4** | `docs: server-split architecture` | 文档 | 1d | docs/architecture/SERVER-SPLIT.md |
| **W5** | `chore: extract lsh-fixture.json` | 1000 条 fixture | 2d | npm run test:cross 0 失配 |
| **W5** | `feat(lsh): add normalize flag (v1.1)` | LSH 协议 v1.1 | 3d | CI 全绿 |
| **W6** | `refactor(lsh-py): switch to node-subprocess bridge` | 单端权威 | 3d | 启动延迟 <50ms |
| **W6** | `test(lsh): 1000 fixtures cross-language equivalence` | CI 门禁 | 2d | 0 失配 |
| **W7** | `feat: add Zod-based runtime validators` | 类型生成 | 3d | validators 全部生成 |
| **W7** | `feat: add Pydantic v2 models` | Py 端类型 | 2d | types/*.py 完整 |
| **W8** | `chore: gen:types script + docs` | 收尾 + 文档 | 1d | bun run gen:types 一键 |
| **W8** | `release: v3.2.0 - god-server split + lsh sync` | 发布 | 1d | GitHub Release |

**阶段验收**：所有 P0 债项关闭，CI 7 个 workflow 全绿，v3.2.0 stable

### Phase 2：可扩展性 + 安装体验（W9-W16 / Q4 2026 · 10-12 月）

**目标**：让 100K embeddings 也能用，让新用户 5 分钟跑起来

| 周次 | PR 标题 | 主要工作 | 工时 | 验收 |
|---|---|---|---|---|
| **W9** | `refactor: rewrite start-shared-mcp.ps1 (no PowerShell Hidden)` | 去 shim | 3d | 0 黑窗 |
| **W9** | `feat: add ~/.ai-memory/logs/ structure` | 日志规范 | 2d | 失败可见日志 |
| **W10** | `feat(retrieval): add --use-ann flag (opt-in)` | ANN 入口 | 3d | P95 <300ms |
| **W10** | `feat(retrieval): auto-select ANN at 10K+` | 自动选择 | 2d | 性能日志埋点 |
| **W11** | `feat(retrieval): streaming search results` | 分批返回 | 3d | 单次响应 <100ms |
| **W11** | `docs: when to enable ANN` | 文档 | 1d | docs/guides/PERFORMANCE.md |
| **W12** | `ci: add macos-13/14/15 matrix` | CI 扩展 | 2d | macOS 全绿 |
| **W12** | `ci: add linux arm64 matrix` | Linux 扩展 | 1d | arm64 全绿 |
| **W13** | `feat: install LaunchAgent on macOS` | Mac 注册 | 2d | 启动/停止测试 |
| **W13** | `feat: install systemd --user on Linux` | Linux 注册 | 2d | 启动/停止测试 |
| **W14** | `test: platform/mac integration smoke` | Mac e2e | 2d | install→start→query→stop |
| **W14** | `test: platform/linux integration smoke` | Linux e2e | 2d | 同上 |
| **W15** | `chore: bun run typecheck (all TS d.ts files)` | 类型补全 | 2d | 0 error |
| **W15** | `test: integration coverage ≥60%` | 测试覆盖 | 3d | coverage report |
| **W16** | `release: v3.3.0 - ann + cross-platform` | 发布 | 1d | GitHub Release |

**阶段验收**：100K embeddings 查询 P95 <300ms，跨平台 CI 全绿，v3.3.0 stable

### Phase 3：智能化 + 校准（W17-W23 / Q1 2027 · 1-3 月）

**目标**：让 promotion 决策可量化，让工具用起来"越用越准"

| 周次 | PR 标题 | 主要工作 | 工时 | 验收 |
|---|---|---|---|---|
| **W17** | `data: collect 200+ promotion judgments` | 数据集 | 3d | tests/fixtures/*.jsonl |
| **W17** | `docs: promotion annotation guide` | 标注规则 | 1d | docs/specs/... |
| **W18** | `feat: ops/eval/promotion-eval.py` | 评测脚本 | 2d | 输出 P/R/F1 |
| **W18** | `docs: baseline promotion report` | 报告 | 1d | docs/reports/... |
| **W19** | `chore: grid-search optimal thresholds` | 校准 | 3d | precision ≥0.8 / recall ≥0.7 |
| **W19** | `docs: promotion-thresholds-v2.md` | 文档 | 1d | 固化阈值 |
| **W20** | `ci: add promotion-eval.yml (weekly)` | CI 门禁 | 1d | 阈值回退 fail |
| **W20** | `chore: typed generation for all 5 tiers` | 类型补全 | 2d | types/*.d.ts 完整 |
| **W21** | `docs: vitepress site scaffold` | 文档站 | 3d | docs-site/ 启动 |
| **W21** | `chore: migrate docs to docs-site/` | 文档迁移 | 2d | 8 个原 MD 迁移 |
| **W22** | `docs: full-text search + dark mode` | 文档站完善 | 3d | docs.obsidian-shared-memory-bus.dev |
| **W22** | `chore: doc CI (link check, build check)` | CI 加 | 1d | GitHub Pages 自动部署 |
| **W23** | `release: v4.0.0 - intelligent tiering + docs site` | 发布 | 1d | GitHub Release |

**阶段验收**：5-tier promotion precision ≥0.8，文档可全文搜索，v4.0.0 stable

---

## 4. 风险登记表

| 编号 | 风险 | 概率 | 影响 | 缓解 | 负责人 | 触发条件 |
|---|---|---|---|---|---|---|
| R1 | God Server 拆分破坏向后兼容 | 中 | 高 | 端口映射层 + 兼容层 v3.2 永保留 | Tech Lead | MCP 调用失败率 >1% |
| R2 | LSH 同步引入启动延迟 | 中 | 中 | `--lsh-bridge=inline\|spawn` flag | Dev | P95 启动 >200ms |
| R3 | ANN 引入 Py 依赖 | 高 | 中 | 默认关闭 + opt-in | Dev | numpy 装失败 |
| R4 | macOS 路径 bug 在 Linux CI 才发现 | 中 | 中 | 修复前先发 RC | Dev | 实际安装失败 |
| R5 | 类型生成与手写校验冲突 | 中 | 中 | 双轨期 1 minor 版本 | Dev | 校验 fail |
| R6 | PowerShell 7 装失败 | 中 | 中 | 保留 PS 5.1 fallback | Dev | Windows 7/8 仍用 |
| R7 | 单人精力耗尽 | 中 | 高 | W1 起招 co-maintainer | Owner | sprint 完成 <70% |
| R8 | Contributor PR 质量差 | 中 | 中 | 严格 review + CI 门禁 | Owner | 1 周内回 PR |
| R9 | v3.2.0 引入新 bug | 中 | 高 | RC 期 2 周 + 内测 10+ 人 | Owner | issue 暴增 |
| R10 | claude-mem 直接竞争 | 低 | 中 | MIT 差异化 + KOL 关系 | Owner | HN/R 双方对峙 |

---

## 5. 回滚策略

### 5.1 Tag 策略

```bash
# 每个 Phase 结束前打 tag
git tag -a v3.1.0-monolith -m "Last monolithic release"
git tag -a v3.2.0-rc1 -m "Server split + LSH sync"
git tag -a v3.2.0-stable -m "After 2 weeks of soak testing"
```

### 5.2 用户回退

- 在 README 顶部加"Stability Tiers"说明
- v3.1.0-monolithic tag 永保留
- 提供 `npm install obsidian-shared-memory-bus@3.1.0` 即可退回
- 文档：`docs/RELEASING.md` 写明回退步骤

### 5.3 数据回退

- `~/.ai-memory/` 下的数据格式不变（schema 兼容）
- 索引文件可重建（`bun run rebuild-index`）
- 跨语言 LSH fixture 永不删除

---

## 6. 贡献者招募操作手册

### 6.1 招募画像

| 角色 | 数量 | 关键技能 | 招募渠道 |
|---|---|---|---|
| **Windows PowerShell 专家** | 1 | PowerShell 5.1 + 7、Win32 API、VBS | PowerShell Galley、r/PowerShell |
| **Python 检索专家** | 1 | BM25、向量库、HNSW | r/MachineLearning、HackerNews 评论区 |
| **TypeScript / Node.js 专家** | 1（可兼） | MCP SDK、Node 22+、SQLite | awesome-mcp-servers Contributors |
| **文档 / DevRel** | 0.5 | 中英双语、技术写作 | devrel-list 邮件列表 |

### 6.2 招募话术（英文 / 中文各 1）

**英文（GitHub Issue 模板）**：

```markdown
## Help Wanted: Server Split Refactor

We're splitting our 1447-line `omni-memory-server.js` into 4 single-purpose servers.
This is **good first issue** — strict scope, clear acceptance criteria.

**Scope**: Extract `manifest-loader.js` (≤200 lines)
**Time estimate**: 2-3 days
**Difficulty**: Easy-Medium

**What you'll learn**:
- MCP (Model Context Protocol) server architecture
- ESM module patterns in Node.js 22+
- Real-world refactoring with 100% backward compatibility

**Mentorship**: I'll personally review your PR within 24h.

**Reward**: First merged PR → triage permissions + co-author credit in v3.2.0 release notes.
```

**中文（即刻 / V2EX 帖）**：

```
招 1-2 个 co-maintainer，帮我一起做 obsidian-shared-memory-bus 的工程化。

项目情况：
- 6.9 万行 PS/Node/Py 三端代码
- MCP 协议，AI 工具记忆共享
- 当前 1 star，需要把它从"能跑"做到"易维护"

具体债项 7 个，技术债修复 roadmap 我都写好了：
- God Server 拆分（3 周）
- LSH 跨语言同步（2 周）
- 类型生成（2 周）
...

你可以挑 1-2 个你感兴趣的债项做，PR 合了我直接给你 triage 权限。
不要求天天上线，每周 5 小时能保持节奏就行。

项目地址：https://github.com/passionworkeer/obsidian-shared-memory-bus
我的微信：xxx
```

### 6.3 维护节奏

- **每周 1 次同步会**（30min，Discord）
- **每月 1 次"Engineering Update"**（邮件 + GitHub Discussions）
- **每 Phase 结束发 1 篇深度博客**（含数据 + 截图）

---

## 7. 验收 Checklist（每个 PR 必查）

- [ ] 单一文件 ≤ 400 行
- [ ] 单元测试覆盖新代码 ≥80%
- [ ] 跨语言测试 1000 条 0 失配
- [ ] CI 7 个 workflow 全绿
- [ ] CHANGELOG.md 更新
- [ ] 涉及 schema 变更时 `gen:types` 跑过
- [ ] 文档同步更新（如有 API 变化）
- [ ] 不引入新的 npm 依赖（除非 P0 必需）
- [ ] 类型签名完整（JSDoc / .d.ts）
- [ ] 错误信息含 trace ID
- [ ] Performance 不退化（benchmark script）
- [ ] 至少有 1 个 reviewer approve

---

## 8. 长期演进（Q2 2027+）

在 Q3 2026 - Q1 2027 三阶段完成后，可考虑：

### 8.1 Monorepo 拆分

```bash
@ai-memory/bus-core      # PS + Node 核心
@ai-memory/retrieval     # Py 检索服务（pip package）
@ai-memory/mcp-servers   # 9 个 MCP server（npm）
@ai-memory/cli           # 命令行工具（npm）
@ai-memory/types         # 共享类型（npm）
```

### 8.2 TypeScript 正式迁移

- 用 TypeScript 5.x 重写 `shared-mcp/` 下所有 JS
- 保留 PS + Python 不动（interop via JSON RPC）
- 双类型：JSDoc（过渡）+ .ts（目标）

### 8.3 v5.0 LTS

- 承诺 12 个月 API 稳定期
- 移除所有 deprecation 警告
- 提供 migration guide for v4 → v5

---

## 附录 A · 测试覆盖目标拆解

| 模块 | 当前估计 | 目标 | 优先级 | 备注 |
|---|---|---|---|---|
| `bus/bm25.js` | 70% | 90% | P0 | 关键检索路径 |
| `bus/lsh-hash.js` | 60% | 95% | P0 | 跨语言核心 |
| `bus/generate-embeddings.js` | 30% | 70% | P0 | embedding 入口 |
| `shared-mcp/omni-memory-server.js` | 20% | 60%（拆完后） | P0 | 拆分后易测 |
| `retrieval/search_ranking.py` | 25% | 80% | P1 | 混合排序 |
| `retrieval/embedding_providers.py` | 40% | 85% | P1 | 4 个 provider |
| `ops/memory/*` | 35% | 75% | P1 | ops 路径 |
| `ops/knowledge/knowledge-graph.js` | 50% | 85% | P1 | 知识图谱 |
| 跨语言一致性 | 1000 条 | 10000 条 | P2 | CI 门禁 |

## 附录 B · CI 矩阵规划详细 YAML

参见 §7.2

## 附录 C · 与宣传 Playbook 的耦合

| 债项 | 宣传影响 | 关键素材 |
|---|---|---|
| #1 God Server 拆分 | "300+ contributors ready to join" | 架构图 |
| #2 LSH 同步 | "MIT-licensed, reproducible across languages" | 协议文档 |
| #3 类型生成 | "TypeScript-ready, IDE autocomplete works" | 截图 |
| #4 Windows shim | "0 black windows, full logs" | 录屏对比 |
| #5 ANN 检索 | "100K memories in 300ms" | benchmark 截图 |
| #6 promotion 校准 | "precision 80%, recall 70%" | 评测报告 |
| #7 跨平台 CI | "Mac/Linux/Windows all green" | CI badge |

**关键约束**：**不要在技术债修复完成前做大规模宣传**，否则会因 bug 流失用户口碑。建议 Phase 1 完成后（约 8 周）再启动获客。

## 附录 D · 一页纸项目状态报告模板

```markdown
# Status Report - Week X (2026-MM-DD)

## 本周完成
- [PR-1.1] manifest-loader.js 提取 + 100% 覆盖
- [PR-1.2] mcp-process-manager.js 提取 + 集成测试

## 本周指标
- 单元测试覆盖率：38% → 42%
- 单一文件 >400 行数：1 → 0
- 跨语言测试：1000 条 fixture，0 失配

## 下周计划
- [PR-1.3] 拆 omni-memory-retrieval-server

## 风险
- R3（ANN Py 依赖）：决定先 opt-in，默认关闭

## 阻塞
- 无

## 需要帮助
- 寻找 1 个 Windows PowerShell co-maintainer
```
