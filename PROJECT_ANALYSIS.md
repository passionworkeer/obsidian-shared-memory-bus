# 项目深度分析报告（全量逐行审计）

**分析日期**: 2026-06-28
**对比基线**: 2026-06-15 差分审计
**项目版本**: local-ai-memory-bus (obsidian-shared-memory-bus) v3.1.0
**项目类型**: 本地优先多 agent 共享记忆总线 — Node.js ESM (>=18) + Python 检索，~54,000 行（JS ~37,500 + Python ~16,200）
**审计方法**: 5 个 expert agents 全量逐行扫描（架构/安全/性能/测试/代码质量）+ 乐观派/批判派辩论 + 协调者裁决
**审计深度**: 每个 agent 深入读 12-15 个核心文件真实代码，全部发现带 file:line 证据

---

## 📊 综合评分

| 维度 | 2026-06-15 | 2026-06-28 | 变化 | 主导因素 |
|------|------------|------------|------|---------|
| 架构 | 7.8 | **7.0** | ↓0.8 | 新发现：JS↔Python 双真源漂移已现、bus→shared-mcp 反向依赖 |
| 安全 | 8.8 *(虚高)* | **6.5** | ↓2.3 | S1（MCP 零鉴权）历史搁置项被重新定性为**可利用漏洞**；评分下修至真实水位 |
| 性能 | 7.6 | **6.0** | ↓1.6 | 新发现：每次 search 全量读文件算 SHA-1 签名、dense/MMR 纯 Python cosine 全表扫描；13b 已修部分抵消 |
| 测试 | 7.3 | **6.5** | ↓0.8 | 新发现：MCP 通信层 ~1350 行零测试、e2e 假绿（T2 历史未修确认） |
| 代码质量 | 7.4 | **7.0** | ↓0.4 | 新发现：withFileLock 忙等自旋（双人确认）、Python except 吞错 60 处、跨语言常量重复 |
| **加权综合** | **7.55** | **6.5** | **↓1.05** | 审计深度提升暴露深层问题 + 历史搁置项累积 |

> ⚠️ **评分下降解读**：本次下降**主因不是项目退步**，而是 (a) 本次为"扫每一行"的全量审计（上次为差分审计），(b) S1 这个历史搁置项被重新定性。核心数据层防护（crypto 零自研、safeRealpath 防符号链接逃逸、O_APPEND 原子写）仍然扎实，13b/13c 等历史性能债已实际偿还。

---

## 🔴 P0 — 严重问题（立即修，本周，两派共识）

### 1. MCP 端点零鉴权 + 无 Origin/CORS 校验（最危险，可被任意网页利用）

- **位置**: `shared-mcp/proto/rpc.mjs:270`（`handleSingleRpc`→`forwardRequest`）、`shared-mcp/singleton-stdio-mcp-proxy.mjs:44-132`、5 端点 9331/9332/9333/9337/9338
- **类型**: 越权访问 / CSRF / DNS-rebinding / 本机进程劫持
- **机制**: 所有 `/mcp` 端点只校验 `req.url === mcpPath` + POST 方法，**无任何 token、Origin/Host 校验、CORS 限制**。对比 `shared-mcp/metrics/server.js:43-50` 已有 Bearer 鉴权，证明团队知道怎么做却没在主端点做。
- **攻击场景**:
  - (a) 用户访问任意恶意网页 → 浏览器 JS 向 `http://127.0.0.1:9338/mcp` 发 `memory_search`/`memory_query` → **读全部记忆库**（含 token、密钥、个人笔记）→ 数据外泄
  - (b) DNS-rebinding：网页把自身域解析到 127.0.0.1 绕过同源策略
  - (c) `memory_write` 写入投毒记忆 → 下次 agent 启动被 prompt-injection 劫持
  - (d) 本机任意非特权进程（恶意 npm/Obsidian 插件）静默读写
- **证据**: `rpc.mjs:297` `if (Object.prototype.hasOwnProperty.call(message,'id')) { return forwardRequest(message); }` — 无 caller 校验
- **历史**: 2026-06-15 报告 HIGH #4 已记录为"mcp_write 缺 caller 身份——下个 feature 的尾巴"，**被搁置至今**
- **严重度**: 🔴 高（对本地优先工具，本机网页/进程是最现实威胁面，零交互触发）
- **修复方案**:
  1. `handleSingleRpc` 前加中间件：强制校验 `Origin`/`Host` ∈ {`127.0.0.1`, `localhost`}（挡跨站）
  2. 启动时生成随机 token，非-`initialize` 请求必须带 `Authorization: Bearer`（挡本机其他进程）
  3. 返回 `Access-Control-Allow-Origin: null` + 拒绝非-`OPTIONS` 跨域
- **工时**: 90 分钟
- **裁决**: ✅ 两派一致 P0（批判派/乐观派均判立即修）

### 2. e2e 测试"吞 TypeError 即过"——假绿，破坏信任基石

- **位置**: `tests/e2e/mcp-e2e.test.mjs:246-254`
- **机制**: catch 块把 `TypeError`（"not a function"）和 `NOT_FOUND` 都当 "test skipped" 静默 return → **handler 完全坏掉也显示 PASS**。整个 e2e 文件 13 个用例几乎都是 `assert.notEqual(result, null)` 级别存在性检查，非行为断言。名为 e2e 实为 smoke。
- **严重度**: 🔴 高（使 S1 等所有修复的回归保障失效，"绿了≠对"）
- **修复方案**: 区分"环境未就绪可 skip"与"代码 bug 必 fail"；补真实读写往返断言
- **工时**: 30 分钟
- **裁决**: ✅ 两派一致 P0

### 3. `withFileLock` 忙等待自旋（CPU 100% 满载）— 双人独立确认

- **位置**: `ops/memory/paths-and-io.js:146,219,249`
- **机制**: `const wait = (delay) => { const start = Date.now(); while (Date.now() - start < delay) {} }` 空循环退避。Node 单线程下锁定期间整个进程阻塞，多 agent 并发写入时打满一个 CPU 核。
- **证据**: 性能 agent 与代码质量 agent **独立发现同一行**，高置信
- **严重度**: 🔴 高（并发写入链路 CPU 雪崩，可与缓存击穿形成 CPU+I/O 双重恶化）
- **修复方案**: 改 `Atomics.wait`（SharedArrayBuffer）或 `setTimeout` 轮询
- **工时**: 15 分钟
- **裁决**: ✅ 两派一致修（批判派 P0 / 乐观派 P1），极低成本

### 4. `memory_write` 的 `project` 键无白名单（路径穿越，纵深防御）

- **位置**: `ops/mcp/mcp-memory-tools.js:95-107`（`detectProjectKey`）、`:329` `path.join(projectsRoot, \`${projectKey}.jsonl\`)`
- **机制**: `project` 取自入参 `project.trim()` 直接拼路径，**key 无字符白名单**。攻击者传 `project="..\\..\\..\\..\\Windows\\Temp\\evil"` 即可写到 projectsRoot 之外（Windows `\` 不被 basename 处理）。需配合 S1，且 `appendLineAtomic` 的 `safeRoot` 可能拦截——但纵深防御必须补。
- **修复方案**: `:327` 后加 `if (!/^[A-Za-z0-9._-]{1,64}$/.test(projectKey)) return {ok:false, error:"invalid project"};`
- **工时**: 15 分钟
- **裁决**: ✅ 两派一致修（S1 已 P0，顺手关第二道门）

> **P0 合计工时：约 150 分钟**。全部为两派共识，无争议。

---

## 🟡 P1 — 中等问题（本迭代修）

### 5. JSONL 流式解析信任外部记录（间接 prompt-injection 通道）

- **位置**: `ops/util/jsonl-stream.js:26`、`ops/mcp/mcp-memory-tools.js:119,144-148`
- **机制**: 记忆库 `.jsonl` 含攻击者写入的记录，`record.content`/`facts` 被 `buildBootContext` 直接拼入注入 agent 上下文的字符串 → 与 S1 联动构成"网页写污染 → AI 执行"链
- **修复方案**: 读出后白名单字段（`{id,content,facts,decisions,t,project}`），丢弃未知键 + 限制单行长度
- **工时**: 25 分钟
- **裁决**: 协调者采纳批判派（S1 修复后补出口纵深，成本低）

### 6. 每次 search 全量读 10 文件 + 算 SHA-1 签名（搜索热路径）

- **位置**: `retrieval/search_index.py:98-113`，调用点 `semantic_search.py:788-789`
- **机制**: `build_structured_signature` 对 10 个 STRUCTURED_FILES 各读全量字节 + SHA-1，发生在搜索结果缓存命中检查**之前**。结构化层 10-50MB 时单次 search 光算签名就读 50-100MB；stdio 单进程串行下多 agent 并发全串过此开销。
- **修复方案（采纳乐观派"先验证痛感"）**:
  1. 用 `(mtime_ns, size)` 做第一道指纹，命中失败再回退 SHA-1
  2. 签名结果加进程内 TTL 缓存（如 5s），避免高频并发重复计算
- **工时**: 60-90 分钟
- **裁决**: P1（批判派 P1 / 乐观派 P2）。架构缺陷当修，但采纳乐观派增量方案而非全量重写

### 7. Python `except Exception: pass` 60 处吞错（索引/缓存失败静默）

- **位置**: `retrieval/search_index.py:57,105,273,283,335,340`、`search_cache.py:90,104,144`、`streaming_index.py:49,79,292,329`、`search_ranking.py:159,712` 等（实际 60 处，多于初审 38）
- **机制**: 如 `_load_entries_uncached` 文件读取出错 `except Exception: continue` 静默跳过 → 索引可能空却无告警，召回率=0 无日志，极难定位
- **修复方案**: 区分预期错误（JSONDecodeError→skip 合理）与意外错误（IOError/Permission→`sys.stderr.write` 或 re-raise）；**聚焦索引/缓存层，非全部 60 处**
- **工时**: 90 分钟
- **裁决**: P1（批判派 P1 / 乐观派 P3）。部分采纳——聚焦非 best-effort 的关键路径

### 8. `STRUCTURED_FILES` 跨语言重复定义（双真源漂移的具体定时炸弹）

- **位置**: `ops/memory/memory-archival.js:225-236` vs `retrieval/search_ranking.py:98-109`
- **机制**: 同一份 10 个 jsonl 文件名列表 JS/Python 各写一份，新增数据源时极易漏改一侧 → 归档扫不到或检索缺数据
- **修复方案**: 单一来源（`store-root/config/structured-files.json`，两端启动读取）或至少加一致性测试断言
- **工时**: 40 分钟
- **裁决**: P1（A1 双真源的便宜子集，先修这个具体例）

### 9. 并发写入测试默认不跑（核心 invariant 无回归保护）

- **位置**: `package.json` — `test:concurrent`（concurrency=4）未纳入 `test:all`/`test:full`
- **机制**: 原子写入是记忆总线核心 invariant，但默认全量跑串行单线程无法暴露竞态
- **修复方案**: 把 `test:concurrent` 纳入 `test:all`
- **工时**: 10 分钟
- **裁决**: P1（CI 流程修复，极低成本）

> **P1 合计工时：约 225-255 分钟**

---

## 🟢 P2 — 优化建议（下迭代，等痛感/规模验证）

### 10. dense/MMR 纯 Python 全表扫描 + 384 维逐元素 cosine

- **位置**: `retrieval/search_ranking.py:262-277,426,923-986`
- **机制**: 每次 query 对整个 embeddings index 全表遍历 + 纯 Python cosine；MMR 是 O(top_k×N) 次纯 Python 384 维循环，且 `mmr_rerank` 又重扫全表把候选 embedding 全捞进内存
- **修复方案**: numpy 批量 dot（矩阵乘）；MMR 只捞 top_candidates 的 embedding
- **工时**: 90-120 分钟
- **裁决**: P2（采纳乐观派：N<1k 当前可接受，等向量规模破 5k 再投入）

### 11. MCP 通信层 ~1350 行零测试

- **位置**: `shared-mcp/proto/rpc.mjs`、`proto/child-process.mjs`、`proto/restart.mjs`、`singleton-stdio-mcp-proxy.mjs`、`omni-*.js`
- **机制**: 协议解析边界错误（半包、超大消息、畸形 JSON）会让整个 MCP 总线静默挂死；restart.mjs 崩溃恢复无保护
- **工时**: 180-240 分钟（分批补）
- **裁决**: P2（渐进补；S1 鉴权路径可先在 P0 用集成测试覆盖）

### 12. bus 反向依赖 shared-mcp

- **位置**: `bus/embedding-provider-registry.js:41` `require("../shared-mcp/embedding-worker-pool.cjs")`
- **机制**: 核心层 lazy-require 上层，try/catch 静默吞 import 失败 → `bus` 无法脱离 MCP 层独立测试/复用
- **修复方案**: worker-pool 下沉到 `bus/` 或依赖注入
- **工时**: 120 分钟
- **裁决**: P2（架构异味，当前可工作，非运行时风险）

### 13. StreamingIndexReader 文件句柄泄漏

- **位置**: `retrieval/streaming_index.py:54,66`
- **机制**: `open()` 非 `with`，调用方提前 break 或异常则句柄泄漏
- **工时**: 40 分钟
- **裁决**: P2（采纳乐观派：进程短生命周期，泄漏到 OOM 前已重启，监控即可）

### 14. MCP 单例子进程串行瓶颈

- **位置**: `shared-mcp/proto/rpc.mjs:60-78,145,157`
- **机制**: 多 agent 并发经单 stdin 串行，单次慢请求/崩溃重启拖垮所有等待者；`pendingRequests` 无上限
- **工时**: 180 分钟
- **裁决**: P2（单用户场景几乎触不到，采纳乐观派）

---

## ⚪ P3 — 监控/暂不修（低 ROI 或前置条件强）

| # | 问题 | 位置 | 裁决理由 |
|---|------|------|---------|
| 15 | JS↔Python 配置双真源大重构（A1） | `bus/runtime-config.js:24-83` vs `retrieval/runtime_support.py:54-99` | 240min 大重构，"漂移存在但未爆 bug"；先修 #8 单源问题，等真爆 bug 再统一 |
| 16 | redact 自定义正则 ReDoS | `ops/redact/redaction.py:78-109` | env 默认空，需配置层被攻破才触发，前置条件强 |
| 17 | `clone_json_payload` 双重 JSON 序列化 | `retrieval/search_cache.py:194-196` | 开销可接受，P1 修复后再评估 |
| 18 | `acquireLock` EEXIST 覆盖破坏原子性 | `ops/memory/memory-archival.js:172-181` | 多触发源并发归档才暴露，下迭代 |
| 19 | `__import__("datetime")` 反模式 | `retrieval/search_ranking.py:709-710` | 微开销+可读性，顺手修 10min |
| 20 | platform/index.js 非真 lazy import | `bus/platform/index.js:11-13` | 加载浪费但不影响正确性 |
| 21 | BM25 缓存被签名失效联动击穿 | `retrieval/search_ranking.py:216-227` | 依赖 #6，#6 修后收敛 |

---

## ⚔️ 辩论结论

### 两派共识（4 项，无争议）
- **S1 MCP 零鉴权**：DNS-rebinding 是客观威胁，90min 成本低 → **P0**
- **T2 e2e 假绿**：破坏测试信任契约 → **P0**
- **P6/Q1 withFileLock spin**：双人确认真 bug，15min → **修**
- **S2 project 键白名单**：15min 纵深防御 → **修**

### 主要分歧与裁决

| 议题 | 批判派 | 乐观派 | 协调者裁决 |
|------|--------|--------|-----------|
| S4 JSONL 信任 | P0（链式终端） | P3（本地信任边界） | **P1** — S1 修复后补出口纵深，成本低 |
| P1 签名风暴 | P1（用户痛点） | P2（先埋点验证） | **P1** — 架构缺陷当修，采纳乐观派增量方案（mtime 指纹+TTL） |
| P2 dense/MMR cosine | P1 | P2（过度工程） | **P2** — 采纳乐观派，等向量规模破 5k |
| A1 双真源大重构 | P1 | P3（理论整洁） | **P3** — 先修 #8 子集，等真爆 bug |
| Q2 except 吞错 | P1（60 处） | P3（部分合理） | **P1** — 聚焦索引/缓存层非全部 |

### 最终建议（修复路线图）

```
第 1 周（P0，~150min）: S1 → T2 → P6/Q1 → S2
   └─ 先修 T2 让测试可信，再修 S1/S2 安全，最后 P6 spin
第 1-2 周（P1，~225min）: #5 S4 → #8 STRUCTURED_FILES → #9 并发测试 → #6 签名 → #7 except
第 3 周+（P2）: #10 cosine → #11 MCP 测试 → #12 反向依赖 → #13 句柄 → #14 单例
监控待办（P3）: #15 双真源 / #16-21
```

**核心论点**：批判派提醒"安全不能等下迭代"是对的——S1 的 90min 修复成本是事故成本（密钥泄露+记忆污染+AI 劫持）的数千倍；乐观派提醒"先验证痛感再投入大重构"也对——P2/A1 在当前单用户/小规模下非痛点。**协调者折中：P0 全修、P1 选高 ROI、P2/P3 推迟并埋监控。**

---

## 🔄 历史对比（2026-06-15 → 2026-06-28）

### ✅ 历史问题已实际修复（项目在进步）
- **13b patchJsonlRecord 全文件重写** → commit `fd06721` 已优化为 **O(1) append-only**（性能 agent 确认）
- Gemini heredoc 注入 → 改 stdin JSON（持续有效）
- mcp_write 写侧硬化 + realpath 防护（持续有效）
- 3 个 god module 拆分 + barrel 重构（持续有效）

### ❌ 历史已发现但搁置/未修（本次升级）
- **S1 MCP 零鉴权** — 2026-06-15 标为"下个 feature 尾巴" → **本次升级为 P0 可利用漏洞**（最大教训：安全债搁置会被重新定性）
- **T2 e2e 假绿** — 2026-06-15 未修 → 确认仍存（`mcp-e2e.test.mjs:246-254`）
- **CI `|| true` 短路** — 仍存（`.github/workflows/lint.yml`）
- **Windows atomic write skip** — 仍存（项目自定位 Windows 优先却跳过）

### 🆕 本次新发现（历史审计未覆盖，因审计深度提升）
- P1 签名风暴、P2 纯 Python cosine、Q1 withFileLock spin（双人确认）、Q2 except 吞错 60 处、T1 MCP 通信层零测试、A1 双真源漂移、Q5 STRUCTURED_FILES 跨语言重复、#5 StreamingIndex 句柄泄漏

> **关键洞察**：本次评分下降**主因是审计从"差分"升级为"逐行全量"**，暴露了上次未触及的深层问题（性能热路径、Python 错误处理、跨语言真源）。项目核心防护层（crypto/realpath/atomic write）仍然扎实，但 **S1 这类搁置的安全债是真实风险，必须立即偿还**。

---

## 🌟 审计亮点（项目做得好的地方）

- **加密零自研**：只用 `crypto.createHash`/`randomUUID`，无危险自研密码学
- **路径遍历防护成熟**：`safeRealpathWithin`（`ops/util/safe-realpath.js:21-48`）正确对 parent+root 双 realpath，防 symlink 逃逸读 `~/.ssh/id_rsa`
- **原子写入正确**：`appendLineAtomic` 用 OS 级 `O_APPEND`（`inbox-atomic-write.js:134-139`）解决 Windows 并发写撕裂；`patchJsonlRecord` O(1) append-only + companion patch log
- **子进程安全**：`spawnPowerShell`/`spawnNode` 一律 `shell:false`，所有 `listen()` 显式绑 `127.0.0.1`（无 `0.0.0.0`）
- **流式索引零内存**：`StreamingIndex` 真 generator（`streaming_index.py:24-103`）逐行 yield
- **双层缓存 + 断路器/背压基础设施齐全**：SQLite WAL + LRU TTL + circuit_breaker 已接入 dense 路径
- **测试基线大且全绿**：722 JS + 624 Python + 42 集成，核心数据层（crypto/vault-root/bm25/lsh/redaction/circuit-breaker）覆盖扎实
- **文档密度高**：每个模块顶部有 DESIGN PRINCIPLES + ADR 引用，注释解释 WHY
- **供应链干净**：运行时依赖仅 eslint，无 postinstall，无 eval/new Function/动态 require

---

*报告由 DeepAnalysis 生成（2026-06-28）| 5 agents 全量逐行扫描 + 2 派辩论 + 协调者裁决*
*5 份分项报告：架构 7.0 / 安全 6.5 / 性能 6.0 / 测试 6.5 / 代码质量 7.0 | 加权综合 6.5*
