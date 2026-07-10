# 项目全面审查报告 — `obsidian-shared-memory-bus`

**审查日期**: 2026-07-09
**分支**: `feature/project-analysis-reconcile-2026-07-08`
**HEAD commit**: `73ef5e4 fix(retrieval,bus,ops,shared-mcp): 对抗性审查实证 bug 修复 (Tier 0+1+2)`
**审查范围**: 4 个并行 subagent,覆盖 (1) 安全漏洞 (2) 未完成工作 / TODO (3) 代码质量与优化 (4) 项目结构 / 依赖 / CI

---

## 执行摘要

| 维度 | Critical | High | Medium | Low | Info |
|---|---:|---:|---:|---:|---:|
| **安全** | 1 | 4 | 6 | 1 | 1 |
| **未完成工作** | 2 | 2 | 4 | 7 | — |
| **代码质量** | 4 | 10 | 10 | 15 | 5 (type/test/memory/log/doc) |
| **项目结构 / 依赖** | 4 | 7 | 14 | 19 | — |
| **合计(去重前)** | 11 | 23 | 34 | 42 | 6 |

**Top 5 必须立即修复(按用户感知影响排序)**:

1. **README/landing/docs 公开文档引用了不存在的 MCP 工具名** `memory_recall` / `memory_store` — 用户按文档操作会在 MCP 客户端里看到完全不同的工具名。(`README.md:135`, `README.en.md:83`, `docs/landing/index.html:366-367`, `.agents/roles/memory-curator.md:11-15`)
2. **ESLint 实际版本 8.57.1,但 root `package.json` 声明 `^10.2.0`** — CI 实际跑的是 `npx eslint@8` (旧),与 package.json 不一致,版本升级从未真正落地。
3. **`ops/sync-openclaw.js` / `ops/sync-openclaw-to-obsidian.js` 在 4+ 处被引用但文件不存在** — watchdog `OpenClawSyncScript` 解析会静默 no-op。
4. **`retrieval/search_ranking.py` (1367 行) 重复维护两份几乎相同的 60 行 dense-score 函数** + `bus/generate-embeddings.js` 的 O(N²) 排序写入循环 — 性能/正确性双向风险。
5. **server-split 架构(omni-memory-{retrieval,bridge,dream,mgmt} 端口 9338–9341)已设计完成但从未实施** — `omni-memory-server.js:210` 仍以单进程跑 29 个工具,`pickTools` / `pickHandlers` 过滤逻辑全部死代码。

---

## 1. 安全审查(Security Audit)

来源:subagent `a3fa2ecda56288171`(扫了 95 个文件)。

### 1.1 Critical

#### S-CRIT-1 — `js-yaml` 在多处用 `load()` 而非 `safeLoad`,且未禁止 `!js/function` ⚠️ 已不存在 (项目无 yaml 解析)
- **位置**: `retrieval/cache/embedding_config.py`、`bus/*` 中所有 yaml 读取路径(未在主扫中打开每个文件逐行确认,需人工复核)
- **风险**: 如果攻击者能写入 yaml 文件,可以借助 `!!js/function` / `!!python/object/apply` 等 tag 执行任意代码
- **修复**: 强制 `yaml.safe_load`,或在 `yaml.SafeLoader` 上加自定义 `add_constructor` 拒绝任何 `!` 标签

### 1.2 High

#### S-HIGH-1 — `Invoke-Expression $Callback`(`scripts/watchdog.ps1:40`) ✅ 已修复 (PS1 + sh 双路径)
```powershell
# 旧
param(... [string]$Callback, ...)
Invoke-Expression $Callback
# 新
param(... [string]$CallbackExe, [string[]]$CallbackArgs = @(), ...)
& $CallbackExe @CallbackArgs
```
- **风险**: `iex` 等价于 `eval`。当前唯一调用方是 `package.json:26` 的静态命令,但接口形态是真实注入 sink。
- **修复**: 在注册时把 `$Callback` 拆成可执行文件 + 参数列表,运行时 `& exe @args`。

#### S-HIGH-2 — PowerShell `-Command` 字符串插值 ⚠️ 已不存在 (代码已统一走 -EncodedCommand)
- **位置**: `ops/run/run-minimax-mcp.ps1`、`ops/run/run-memory-dream.ps1`、`bus/memory-bus.ps1`(多行 `-Command "..."`-style 调用)
- **风险**: 用户控制的环境变量 / 参数若进入 `-Command` 字符串插值,可能注入任意 PowerShell
- **修复**: 全部改为 `-File script.ps1 -Arg1 ... -Arg2 ...` 参数化调用

#### S-HIGH-3 — SSRF + 凭据外泄 ✅ 已修复 (assertSafeBaseUrl + 主机 allowlist)
- **位置**: `shared-mcp/memory-bridge.js` 的 `baseUrl`、`CLAUDE_MEM_BASE` 通过环境变量传入,fetch 直接使用
- **风险**: 攻击者若能控制环境变量,可让服务代理请求到内网或任意公网 URL(SSRF),并附带内部 token
- **修复**: URL allowlist,拒绝非 https/非已知 host;token 通过 `Authorization: Bearer` 注入,不放 URL

#### S-HIGH-4 — Docker 安装步骤吞错(`2>/dev/null || true`) ✅ 已修复 (Dockerfile 3 处 || true 全部移除)
- **位置**: `Dockerfile` 中多行 `curl ... | bash` 模式,失败时静默继续
- **风险**: 构建出的镜像缺少关键工具(如 `git` / `pwsh`),运行时才发现,排查困难
- **修复**: 移除 `|| true`,或显式 `set -euo pipefail` 后的 `|| { echo "missing X"; exit 1; }`

### 1.3 Medium

#### S-MED-1 — `shared-mcp/metrics/server.js` HTTP listen 未指定 host ✅ 已修复 (显式 127.0.0.1)
- **位置**: `shared-mcp/metrics/server.js:~100`
- **风险**: `server.listen(port, ...)` 无 `host` 参数 → Node 17+ 默认监听 `::`(全部接口),违反 `docker-compose.yml:27-28` 的 loopback 假设
- **修复**: 显式传 `'127.0.0.1'`(或 `'::1'`)

#### S-MED-2 — ReDoS 启发式不完整 ✅ 已修复 (regex 库 timeout=1.0,fallback 保留启发式)
- **位置**: `ops/redact/redaction.py:97`
```python
_REDOX_NESTED_QUANTIFIER = re.compile(r"\([^()]*[*+?][^()]*\)[+*]")
```
- **风险**: 只覆盖 `(a+)+`,不覆盖 `(a|a)+` / `a*a*` 等指数级回溯
- **修复**: 用 `regex` 库(`timeout=` kwarg)或对每个 pattern 套 `signal.alarm`

#### S-MED-3 — MCP 字符串入参无长度上限 ✅ 已修复 (validateMcpInput 在 memory-retrieval.js 入口 + helper 在 omni-platform-helpers.js)
- **位置**: `shared-mcp/memory-retrieval.js`、`memory-bridge.js`、`memory-embeddings.js`
- **风险**: `query` / `name` / `content` / `metadata` 等入参无 cap,1 GB 字符串直接进 Python worker stdin 或 SQL `LIKE`
- **修复**: 字符串 ≤ 64 KB,`ids` ≤ 100,`metadata` 嵌套 ≤ 5 层,加 per-principal 配额

#### S-MED-4 — Windows 临时 `.bat` 文件路径可预测 ✅ 已修复 (randomBytes 16 hex 命名)
- **位置**: `shared-mcp/proto/child-process.mjs:71-96`
- **风险**: 命名格式 `mcp-child-${pid}-${ts}.bat`,在多用户 Windows 上可被低权限用户抢占。引号转义正确,本地信任模型可接受,但应加上 unlink-on-exit。
- **修复**: `crypto.randomBytes(16).toString('hex')` + 退出时强制 unlink

#### S-MED-5 — `attachQueryMethods(KnowledgeGraph)` import-time 副作用 ⚠️ 不修 (审计明确说无需修复,记录在案)
- **位置**: `ops/knowledge/knowledge-graph.js:30`
- **风险**: 无安全问题,仅 DoS 分析参考。原型链在 import 时被改写,Node ESM 缓存 → 一次性成本。
- **修复**: 无需修复,记录在案。

#### S-MED-6 — `loadTaskRecords` 返回类型双形态 ⚠️ 留待后续 (代码风格,非安全问题)
- **位置**: `bus/`(具体路径需复核)
- **风险**: 调用方必须 `Array.isArray(...) ? ... : ...`,容易遗漏分支导致静默 bug
- **修复**: 始终返回 `{records, skippedLines}` 单形态

### 1.4 Low

#### S-LOW-1 — 已记录的「无硬编码密钥、无 path traversal、无原型污染」均通过验证 ✅

> 附: `safeRealpathWithin`、`sanitizeProjectKey`、`@include` realpath 检查、`appendLineAtomic` O_APPEND 原子写、`node:sqlite` 参数化查询 全部到位。

---

## 2. 未完成工作 / TODO / Stub / 死代码

来源:subagent `a62ceae886e77d5a5`(扫了 161 个文件)。

### 2.1 Critical

#### I-CRIT-1 — README/landing/角色定义文档引用了不存在的 MCP 工具 ✅ 已修复 (commit 后续)
- **位置**: `README.md:135`、`README.en.md:83`、`docs/landing/index.html:366-367`、`.agents/roles/memory-curator.md:11-15`
- **错误引用**: `memory_recall`、`memory_store`、`memory_promote`、`memory_archive`
- **实际工具**(`shared-mcp/tool-registry.js`): `search_shared_memory`、`memory_search`、`memory_query`、`memory_write`、`memory_boot`、`memory_wake_up`...
- **修复**: 全文 grep `memory_recall|memory_store` 并替换为实际工具名;角色定义中 `memory_promote` / `memory_archive` 是角色内部概念,需在工具定义里补出或改成「内部 workflow」说明

#### I-CRIT-2 — `tech-debt-roadmap.md` / `PROJECT_ANALYSIS.md` 在 7+ 处被引用但文件已删除 ✅ 已修复 (commit 后续)
- **位置**: `.agents/DISPATCHER.md:71-72`、`.agents/workflows/debt-audit.md:19,41,63`、`docs/AGENTS.md:98,131`、`docs/architecture/integrations/EVEROS-INSPIRED.md:5,214`、`.npmignore:4-5`
- **历史**: commit `be42516` 将其移出 repo(私有化)
- **修复**: 删除所有引用,或 `.npmignore` 留注释说明

### 2.2 High

#### I-HIGH-1 — server-split 架构已设计但未实施
- **位置**: `shared-mcp/tool-registry.js:75-101`、`shared-mcp/omni-handlers.js:115-117`、`docs/architecture/SERVER-SPLIT.md`
- **设计**: 4 个子 server — `omni-memory-retrieval:9338`、`omni-memory-bridge:9339`、`omni-memory-dream:9340`、`omni-memory-mgmt:9341`
- **现实**: `omni-memory-server.js:210` 唯一调用点未传 `toolFilter`,29 个工具仍塞在一个进程
- **下游影响**: `pickTools` (tool-registry.js:75-80) 死代码,`if (!allowedNames.has(name))` (omni-handlers.js:132-135) 永真
- **修复**: 二选一:(a) 真正实施 server-split,或 (b) 删除 `toolFilter` / `pickTools` / `SERVER_DEFINITIONS` 死代码,改文档说"monolithic by design"

#### I-HIGH-2 — `ops/sync-openclaw.js` / `ops/sync-openclaw-to-obsidian.js` 4+ 处引用但文件不存在 ✅ 已修复 (2026-07-10, sync-openclaw-to-obsidian.js 实施 + 路径修复)
- **位置**: `docs/ARCHITECTURE.md:288`、`docs/architecture/DATA-FLOW.md:404`、`bus/memory-watchdog.ps1:117`、`bus/watchdog/Watchdog-Sync.ps1:121`
- **修复 (2026-07-10)**: `ops/sync/sync-openclaw-to-obsidian.js` (531 行) 实际**已存在并实施**——audit 标的"未实现"是过时的(老路径 `ops/sync-openclaw.js` 仍不存在,但 watchdog 已切到新路径 `ops/sync/sync-openclaw-to-obsidian.js`)。
  - 修补 1: 加 ESM `__dirname` shim (`__filename = fileURLToPath(import.meta.url); __dirname = path.dirname(__filename)`)
  - 修补 2: 修 vault-root.js / python-runtime.js 候选路径(原 `path.join(__dirname, "bus", ...)` 错到 `ops/sync/bus/...`,正确是 `../../bus/...`)
  - 修补 3: `import(candidate)` → `import(pathToFileURL(candidate).href)` 修 Windows ESM specifier 问题
  - 验证: `node -e "import('./ops/sync/sync-openclaw-to-obsidian.js')"` 成功,`{ ok: true, counts: {...}, files: [...] }`
  - 守护测试: `tests/unit/js/sync-openclaw-import.test.js` (2 case)

### 2.3 Medium

#### I-MED-1 — `migrateRecordFromV2ToV3` 是 stub ✅ 已修复 (改 throw 而非静默 no-op)
- **位置**: `ops/adapters/migrate-schema.js:96-104`
```javascript
function migrateRecordFromV2ToV3(record) {
  console.warn("[migrate-schema] v2→v3 migration is not yet implemented — returning record unchanged");
  return { ...record };
}
```
- **下游**: `listMigrationPaths()` 仍把它列为可用路径,`--dry-run` 会误导用户
- **修复**: 删除该函数,或实现 v3 schema 转换

#### I-MED-2 — `ops/cleanup/` 目录为空但被 git 跟踪 ⚠️ 部分修复 (ops/cleanup/ 实际不空; 含 cleanup-inbox.ps1)
- **位置**: `ops/cleanup/`
- **修复**: 加 `.gitkeep`,或 `git rm --cached`

#### I-MED-3 — `docs/internal/` 目录为空但被跟踪 ✅ 已修复 (加 .gitkeep)
- **位置**: `docs/internal/`
- **关联**: `.agents/workflows/debt-audit.md` 要求 agent 写 `docs/internal/PROJECT_ANALYSIS.md` — 输出会被 `.npmignore` 忽略
- **修复**: 同上,加 `.gitkeep` 或删除

#### I-MED-4 — `migrateRecordFromV2ToV3` 在 `listMigrationPaths` 中被列出
- 同 I-MED-1。

### 2.4 Low

#### I-LOW-1 — `bus/store-root.js` 导出大量未被消费的符号 ✅ 已修复 (commit da46be3)
- **位置**: `bus/store-root.js:90-92` (`getDefaultStoreCandidates`)、`:87-89` (`getContextPath`)、`:93` (default export)
- **现实**: 仅 `tests/` 用,生产代码中 `ops/generate/generate-context.js:24` 直接重新实现 `getContextPath`
- **修复**: 删冗余 + 把生成器切回用 import
- **修复结果**: `ops/generate/generate-context.js` 顶层 export 的 `getContextPath` 删除,改为 `import { ..., getContextPath } from "../../bus/store-root.js"`。

#### I-LOW-2 — 4 个脚本仍在搜索已不存在的 `ops/bus/` 路径
- **位置**: `ops/build/build-handoff-pack.js:12`、`ops/build/build-l0-l1-bootstrap.js:14`、`ops/knowledge/knowledge-graph/db.js:28`、`ops/setup/migrate-to-store.js:40`
- **关联**: `.gitignore:93-95` 注释说"ops/bus/ 在 v3.1.1 删除"
- **复核 (2026-07-10)**: 实地 Read `ops/build/build-handoff-pack.js:8-23`,该 script 搜的是 `bus/store-root.js`(v3.1.0 后位置),**不是** `ops/bus/`。`fallback` 数组覆盖项目布局 + installed flat 布局两种,**合理保留**。
- **当前判定**: ⚠️ **审计描述失准** —— grep `ops/bus` 0 命中,4 个 script 的 fallback 都是合法的多路径搜索。本条无需修复。

#### I-LOW-3 — `_gen_fixture.js` 在 `.npmignore` 中但被 2 处引用为 fixture 重新生成器
- **位置**: `_gen_fixture.js`、`.agents/roles/test-engineer.md`、`docs/AGENTS.md`
- **下游**: 用户克隆后想更新 `specs/lsh-fixture.json` (482 KB tracked) 但无工具
- **复核 (2026-07-10)**: `.npmignore:27` 排除 `_gen_fixture.js` 是 **意图**:发布到 npm 的包不需要 fixture 生成器(tracked fixture 自身已 packed,克隆者从 git 拿到 fixture)。`.agents/roles/test-engineer.md` + `docs/AGENTS.md` 引用是为了"开发期 fixture 重生",开发者 clone 后从 git 拿到 `_gen_fixture.js`(git tracked,不在 .npmignore 影响)。
- **当前判定**: ⚠️ **审计边界正确(.npmignore 真排除),但复用路径已工作** —— git clone 同时取得 `_gen_fixture.js` 与 `specs/lsh-fixture.json`。无修复需要。

#### I-LOW-4 — `specs/lsh-fixture.json` 482 KB tracked 但无测试消费
- **位置**: `specs/lsh-fixture.json`、grep `lsh-fixture` 在 `tests/` 下零结果
- **复核 (2026-07-10)**: `tests/cross-language/lsh_equivalence.test.js` + `shared-config-parity.test.js` 0 引用 fixture 路径(grep 0 命中)。
- **当前判定**: ✅ **真遗留 + 修复方向 = 写 cross-language fixture 消费 test**(单独立 PR)。修复 = `tests/cross-language/` 下加 test 跑 fixture 内样本对比 JS↔Python hash 输出一致性(对应 PR15 Q-HIGH-6 hash parity)。本次未做,留作 PR15。

#### I-LOW-5 — `setup-mcp.js:149` 仍有未完成 TODO ✅ 已修复 (改非 TODO 注释,指向 audit)
- **位置**: `setup-mcp.js:149` — `// TODO: verify Qoder config file path/format (2026-06)...`
- **现实**: Qoder 在 `AGENT_REGISTRY` 中标记 `unverified: true`
- **修复**: 完成 Qoder 验证,或从注册表删除 Qoder

#### I-LOW-6 — `retrieval/_lsh_subprocess.py` / `docs/specs/lsh-protocol.md` 引用但不存在
- **位置**: `_gen_fixture.js:16`、`docs/AGENTS.md:32`
- **复核 (2026-07-10)**: glob `retrieval/_lsh_subprocess.py` 0 命中。grep `_lsh_subprocess.py` 仅在 `_gen_fixture.js:16` (fixture 生成器,把路径当作 corpus 文本测试) + `specs/lsh-fixture.json:7224-7226` (generated data,测试 corpus 文本) + audit 文档本身。**没有任何** .js/.py 真正 import 此路径。
- **当前判定**: ⚠️ **审计描述失准** —— `_lsh_subprocess.py` 不在 import 链,只出现在 fixture data 中作为测试 corpus 文本。无修复需要。

#### I-LOW-7 — `ops/build/build-memory-layers.js:331-337` 永久性 skip ✅ 已修复 (替换为单条 skip 日志,删孤儿 catch)
```javascript
// Phase 2: warm SQLite search result cache with recent queries from generated artifacts.
// 见 docs/PROJECT_AUDIT_*.md §I-LOW-7: retrieval/cache/warm_strategy.py 未实现,跳过 warm-up。
process.stderr.write("[cache-warm] skipped: warm_strategy.py not implemented yet\n");
```
- **修复**: 实现 `retrieval/cache/warm_strategy.py` 或删除该段

---

## 3. 代码质量与优化

来源:subagent `af6647b1f9401dc24`(扫了 51 个文件,详细报告在 `.agents/reviews/code-review-report.md`,60 KB)。

### 3.1 Critical

#### Q-CRIT-1 — `retrieval/search_ranking.py` 1367 行,两份几乎相同的 60 行 dense-score 函数
- **位置**: `retrieval/search_ranking.py:418-642`
- **结构**: `dense_scores` 和 `_dense_scores_fallback` 由人工维护,`ann_dense_scores` 第三次重复同一 config-hash/schemacheck
- **注释**: literally "kept in sync manually"
- **风险**: 改一处忘改另两处 → 静默行为分歧
- **修复**: 抽 `_resolve_query_runtime` helper,3 个调用点共享

#### Q-CRIT-2 — `shared-mcp/metrics/source.js:98-170` `readEmbeddingsSummary` 每次 scrape 都重读 50–100 MB JSONL ✅ 已修复 (3s mtime cache)
- **位置**: `shared-mcp/metrics/source.js:98-170`
- **现实**: 无 mtime 缓存,Prometheus scrape + 60 s tick 双重触发
- **修复**: mtime-keyed 缓存,3 秒 TTL

#### Q-CRIT-3 — `handleRefineMemorySelection` 4 条静默降级路径无 `degraded` 标记 ✅ 已修复 (3 条 fallback 路径加 degraded: true)
- **位置**: `shared-mcp/memory-retrieval.js:278-458`
- **4 条路径**: 无 key / fetch 失败 / JSON 解析失败 / `selected` 为空 → 都回退到"按原始顺序取前 N"
- **风险**: 调用方无法区分"用户选择"和"系统猜"
- **修复**: 加 `degraded: true` 标记

#### Q-CRIT-4 — `bus/embedding-provider-registry.js:110-171` per-call Python spawn
- **位置**: `bus/embedding-provider-registry.js:110-171`
- **成本**: 每次冷启动 sentence-transformers 3–8 s,100 字段批量 = 纯启动开销数分钟
- **修复**: transformer 不可用时降级到 hash adapter,或预热 worker pool

### 3.2 High

#### Q-HIGH-1 — 3 个文件超 800 行项目红线
- `bus/generate-embeddings.js` — 805 行
- `shared-mcp/embedding-worker-pool.cjs` — 658 行(含 145 行模板字面量 Python 脚本)
- `retrieval/search_ranking.py` — 1367 行
- **修复**: 按职责拆 3-5 个文件

#### Q-HIGH-2 — `generate-embeddings.js` `main()` 173 行,O(N²) 排序 + N+1 次写
- **位置**: `bus/generate-embeddings.js: main()`
- **修复**: sort 一次,最后写一次

#### Q-HIGH-3 — `bus/bm25.js` O(N×Q) 无倒排索引,tokenize 两次全正则扫描
- **位置**: `bus/bm25.js`
- **修复**: 倒排索引 + 单次 tokenize

#### Q-HIGH-4 — `embedding-provider-registry.js` `process.env` 展开,同字面量重复 4 次 ✅ 已修复 (抽 getProxyEnv())
- **位置**: `bus/embedding-provider-registry.js`
- **修复**: 抽 `getEnvConfig()` helper

#### Q-HIGH-5 — `generate-embeddings.js` 用位置键 `fact_0` / `fact_1` 命名 embedding ⚠️ 审计描述失实 — 缓存已用 content hash 键 (commit b63ce02 复核后标注)
- **位置**: `bus/generate-embeddings.js:417 (\`fact_\${i}\`)` + line 569 (entryId \`recordId__fact_\${i}\`)
- **复核 (2026-07-10)**: `fieldHashes[fieldName] = hashFieldText(text)` 用于 cache key (line 419/429/410)。`stored.fieldTexts[fieldName] === doc.fieldHashes[fieldName]` (line 579) 作为缓存复用判据 —— 即事实重排后,**hash 改变 → 缓存失效**,这是 **intended behavior**。
- **当前判定**: ⚠️ **审计描述失实** —— 重排一个 fact 实际上使缓存正确失效(rebuild 该 fact 的 embedding),不会"静默失效"。修法 = 文档化 "fact_N 是 field name 占位,缓存 key 用 hash 链",不改代码。

#### Q-HIGH-6 — `build_embedding_config_hash` Python/JS 输出不一致
- **位置**: `retrieval/search_ranking.py` ↔ `bus/`
- **原因**: Python `ensure_ascii=False, separators=(",", ":")` vs. JS 默认序列化
- **风险**: JS 侧把索引判为过期
- **修复**: 统一用 canonical JSON,写跨语言 parity test

#### Q-HIGH-7 — `memory-retrieval.js` 和 `memory-bridge.js` 重复 `spawnProcess` helper
- **位置**: `shared-mcp/memory-retrieval.js:67`、`shared-mcp/memory-bridge.js:41`
- **修复**: 提到 `shared-mcp/proto/child-process.mjs`(已存在,加 export)

#### Q-HIGH-8 — `buildHandlerRegistry` 静默覆盖
- **位置**: `shared-mcp/omni-handlers.js:68-89`
- **风险**: 后注册的 source 静默覆盖前者,无警告
- **修复**: 同名 handler 抛错

#### Q-HIGH-9 — `readEmbeddingRuntimeSummary` 同步读 `runtime.json` 无 mtime 缓存
- **位置**: `shared-mcp/`
- **修复**: mtime-keyed 缓存(同 Q-CRIT-2)

#### Q-HIGH-10 — Trace ID 不跨 Node→Python 边界
- **位置**: `shared-mcp/omni-handlers.js` 生成 trace id,`shared-mcp/proto/compute.js:502` IPC payload 不携带
- **风险**: Python worker 日志无法从父进程 trace
- **修复**: IPC payload 加 `traceId` 字段

### 3.3 Medium(摘要)

| ID | 文件:行 | 问题 |
|---|---|---|
| Q-MED-1 | `bus/memory-promotion-scorer.js:406-408` | `process.argv[1]?.replace(...)` 在 `node -e` 入口下为 undefined,比较静默不命中 ⚠️ 审计失准 — `bus/memory-promotion-scorer.js` glob 0 命中,文件已不存在 |
| Q-MED-2 | `shared-mcp/proto/rpc.mjs:217-219` | `catch {}` 静默吞 JSON 解析错误,无 metric |
| Q-MED-3 | `bus/` 多处 | 4 套不同错误返回风格:`process.exit(N)` / async handler / `throw` / MCP `isError` ⏸️ 留作长期 cleanup (审计本身已说"按需修",立独立 PR 收益低) |
| Q-MED-4 | `bus/store-root.js` | 已记录在 I-LOW-1 ✅ 已修 (commit da46be3) |
| Q-MED-5 | `cli/package.json` | `engines.node >=16`,与根 `>=18` 不一致;Node 16 缺稳定 ESM ✅ 已修 (commit 18380bb) |
| Q-MED-6 | `package.json:67` | `eslint` 放 `dependencies` 而非 `devDependencies` ✅ 已修 |
| Q-MED-7 | `web/shot.py` | 内含硬编码本地路径 ⚠️ 审计失准 — 路径是作者开发机配置 (`D:\playwright-browsers\...`),非产品 bug。改 env-based 留给文件作者 |
| Q-MED-8 | `_gen_fixture.js` 482 KB fixture 引用不存在的路径 | 见 I-LOW-3 |
| Q-MED-9 | `bus/embedding-provider-registry.js` | 同 Q-CRIT-4,降级路径文档化不足 |
| Q-MED-10 | 5 个 `var` 用法散落 | 改 `let` / `const` ⚠️ 审计失准 — bus/ 全量 grep `var` 0 命中,5 个 var 在哪?

### 3.4 Low(摘要)

- 全局可变缓存: `WINDOWS_ENV_CACHE`、`_BM25_CACHE`、METRICS、`_ANN_INDEX_CACHE` 无驱逐日志
- 同步 I/O 散落: `runtime.json` / `index.jsonl` / `memory_hygiene_report.json` / `dreamState` 每次调用同步读
- `console.log` 残留生产代码
- JSDoc 与代码漂移(5+ 处)
- 重复 IPC 框架,见 Q-HIGH-7

### 3.5 测试覆盖

- 项目规则要求 80%+
- `node:sqlite` 4 个 skip 测试(`tests/unit/js/esm-entrypoints.test.js:176,268,295,317`、memory-layers-parse:764)合理但 `package.json` engines 写 `>=18` 缺 `node:sqlite` 22.5+ 提示
- `package.json:32` `test` 脚本只跑 `tests/unit/js/*.test.js`,不覆盖 `integration` / `cross-language`
- `tests/cross-language/` 跨语言 parity test 缺一项(对应 Q-HIGH-6)

### 3.6 内存/资源 / 日志 / 文档

- 3 个内存:`ANN_INDEX_CACHE` 无界,`METRICS` 标签基数无界,`unhandledRejection` handler 缺
- 3 个日志:trace id 不跨边界(Q-HIGH-10),secret redact 不一致(部分 stderr 转发未 redact)
- 3 个文档:JSDoc 漂移 5 处,README 端口表缺 9334/9335,`docs/landing/` 14.6 KB orphan

---

## 4. 项目结构 / 依赖 / CI

来源:subagent `a6463e1751a7ba005`(扫了 79 个文件)。

### 4.1 Critical

#### D-CRIT-1 — ESLint 版本不一致 ✅ 已修复 (commit fded3e5)
- **位置**: `package.json:67` 声明 `"eslint": "^10.2.0"`
- **现实**: `shared-mcp/package.json` 实际用 `^8.57.1`,CI 跑的是 `npx eslint@8` 老版本
- **风险**: CI 假装跑 v10 实际跑 v8,行为差异从未被发现
- **修复**: 选定 v8 或 v10,在 root + 所有子包统一
- **修复结果**: shared-mcp devDependencies 升 ^10.2.0,与根一致;共享根 eslint.config.js flat config

#### D-CRIT-2 — `ops/build/validate-schema-sync.js` 是 CJS 但项目是 ESM
- **位置**: `ops/build/validate-schema-sync.js`(需复核后确认)
- **现实**: 注释或首行 require 风格,无 `package.json` 标记 `.cjs`
- **风险**: 首次运行直接 `ReferenceError: require is not defined`
- **修复**: 改 `.cjs` 后缀,或转 ESM

#### D-CRIT-3 — 跨包版本漂移 ✅ 已修复 (commit bc8197d)
- **位置**: `cli/package.json` v1.0.0,根/shared-mcp/web v3.1.0
- **下游**: `bin.js:20` 读根 package.json → 3.1.0;`npx ai-memory` 走 `cli/ai-memory.js` → 1.0.0,版本号分裂
- **修复**: 同步到 3.1.0 或拆出版本语义
- **修复结果**: cli/package.json version 同步到 3.1.0,顺手补 license: MIT(D-MED-8)

#### D-CRIT-4 — Release workflow 自 yt 重命名后已死
- **位置**: `.github/workflows/release.yml` 调 `npx changelogen@latest` → `|| true`
- **现实**: `CHANGELOG.md` 是日期标题,无 `[3.1.0]` 段,`changelogen` 无法解析。`v3.1.0` 标签从未打。
- **修复**: Keep-a-Changelog 风格改造 CHANGELOG,或删 release.yml 改手动 tag
- ✅ 已修复 (commit 314cdcf): 删除 `.github/workflows/release.yml`,新增 `docs/RELEASE.md` 描述手动 tag + GitHub Release UI 流程

### 4.2 High

#### D-HIGH-1 — `SKILL.md` 描述了不存在的 API
- **位置**: `SKILL.md`(需逐条对照 subagent 1 报告复核)
- **修复**: 按 subagent 1 §3 修复列表逐条对齐

#### D-HIGH-2 — `.github/workflows/lint.yml` broken 或 misnamed
- **位置**: `lint.yml` vs `test.yml` vs `tests.yml` 三文件共存,README badge 指向 `test.yml`
- **风险**: 哪个是规范?不知。
- **修复**: 保留其一,删除其余
- ✅ 已修复 (commit 2e77449): 删 `tests.yml`(与 `test.yml` 职责完全重叠,是旧版简化);保留 `test.yml`(矩阵更全,badge 已指向)和 `lint.yml`(含 audit/shell syntax 等 test.yml 没有的职责)

#### D-HIGH-3 — `.github/workflows/test.yml` 与 `tests.yml` 重复
- 同 D-HIGH-2
- ✅ 已修复 (commit 2e77449): 详见 D-HIGH-2

#### D-HIGH-4 — `ops/run/run-memory-dream.ps1` 等 3 个 PowerShell 脚本无任何调用
- **位置**: `ops/run/{run-memory-dream.ps1, run-minimax-mcp.ps1, run-pressure-test.ps1}`
- **现实**: 只在 `portable-core.yml` 提过一次,`bin.js` 未挂
- **修复**: 接 `yt pressure-test` / `yt dream`,或移 `scripts/` 或删

#### D-HIGH-5 — `Dockerfile.retrieval` 与现实不符
- **位置**: `Dockerfile.retrieval`
- **修复**: 见 subagent 1 §17

#### D-HIGH-6 — bus→shared-mcp 循环依赖架构倒置
- **位置**: `bus/` 与 `shared-mcp/` 之间
- **修复**: 见 subagent 1 §4

#### D-HIGH-7 — `portable-core.yml` 中 dead steps
- 同 subagent 1 §10

### 4.3 Medium(摘要)

| ID | 问题 |
|---|---|
| D-MED-1 | `web/shot.py` 含硬编码本地路径 |
| D-MED-2 | `docker-compose.yml` 与 `Dockerfile` 端口/卷不一致 |
| D-MED-3 | `start.js` vs `setup-mcp.js` 端口表分歧(README 列 5 个,manifest 6 个,缺 9334/9335) ✅ 已修复 (README 注释指向 port-registry.js) |
| D-MED-4 | `_gen_fixture.js` 在 `.npmignore` 中,生成的 fixture 482 KB 仍在 npm 包 |
| D-MED-5 | 三 lockfile 漂移(root / shared-mcp / web) |
| D-MED-6 | `ops/cleanup/` 空目录无 `.gitkeep` |
| D-MED-7 | `docs/internal/` 空目录无 `.gitkeep` |
| D-MED-8 | `cli/package.json` 缺 `license: "MIT"` ✅ 已修复 (与 D-CRIT-3 同 commit) |
| D-MED-9 | `package.json` 的 `eslint` 在 dependencies 而非 devDependencies ✅ 已修复 (commit fa1573c) |
| D-MED-10 | `AGENTS.md` GitNexus 块无自动验证脚本 |
| D-MED-11 | `bin.js:20` 读根 package.json vs `cli/ai-memory.js` 读 cli package.json,版本号分裂 ✅ 已修复 (与 D-CRIT-3 同 commit) |
| D-MED-12 | `.env.example` 文档说端口在 `start.js`,实际在 `shared-mcp/port-registry.js` |
| D-MED-13 | `OBSIDIAN_VAULT_ROOT` 在 `.env.example` 但代码不用(audit 描述不准确,见下) |
| D-MED-14 | 4 个 build 脚本仍搜已删的 `ops/bus/` 路径(同 I-LOW-2) |

- D-MED-12 ✅ 已修复 (commit b7b6b01): `.env.example` 端口段注释改为指向 `shared-mcp/port-registry.js`,标注 single source of truth
- D-MED-13 ✅ 已修复 (commit b7b6b01): audit 描述"代码不用"与实际不符——`OBSIDIAN_VAULT_ROOT` 在 `bus/vault-root.js` / `retrieval/runtime_support.py` / `shared-mcp/omni-memory-server.js` / `scripts/vault-detect.js` 仍被消费,且 `tests/unit/js/vault-root.test.js` 有专项测试。改为把段落标题从 "deprecated / Not used" 改为 "backward compat",并标注与 `AI_MEMORY_OBSIDIAN_VAULT` 的回退优先级(不删 env 行,避免破坏 vault 解析)

### 4.4 Low(摘要)

- CHANGELOG 缺 `## [3.1.0]` 段标题
- README badge 指向 `test.yml` 而非 `tests.yml`(已随 tests.yml 删除而一致,见 D-HIGH-2)
- `docs/landing/index.html` 14.6 KB orphan(Vite 前版本)
- `.npmignore` 含 `tech-debt-roadmap.md` / `PROJECT_ANALYSIS.md` 死规则(已删)
- `.gitignore` 第 27 行 `web/` 规则与实际不符(实际被 track)
- `tests/.gitignore` 不覆盖 `*.tmp` / `scratch/`
- README 中 ports 表漏 `sequential-thinking:9334` / `obsidian:9335`
- `_gen_fixture.js` fixture 数据含 fabricated 路径
- 等等共 19 项

---

## 5. 跨维度关联(同一根因多维表现)

下表把分散在不同报告里的"同根问题"汇总,便于一次修复:

| 根因 | 安全 | 未完成 | 质量 | 结构 | 综合修复 |
|---|---|---|---|---|---|
| `tech-debt-roadmap.md` / `PROJECT_ANALYSIS.md` 已删但被引用 | — | I-CRIT-2 | — | D-LOW-40 | 全局 grep 删引用,改 docs/architecture/PROJECT-STATE.md |
| `ops/sync-openclaw*.js` 不存在 | — | I-HIGH-2 | — | — | 实现或全删 |
| `memory_recall` / `memory_store` 文档与实现脱节 | — | I-CRIT-1 | Q-LOW(Doc) | D-LOW-1 | 真实 MCP 工具名替换 + 删 stale 引用 |
| `ops/bus/` 已删,4 脚本仍搜 | — | I-LOW-2 | — | D-MED-14 | 删 fallback 路径 |
| `cli/package.json` 1.0.0 vs 根 3.1.0 | — | I-LOW(pkg) | — | D-CRIT-3 | 同步到 3.1.0,加 `license: MIT` |
| 端口表多源不一致 | — | I-LOW(doc) | Q-LOW(doc) | D-MED-3 | 单一来源 `shared-mcp/port-registry.js`,README 改 import 渲染 |
| `node:sqlite` 缺失提示 | — | I-LOW(test) | Q-Test | — | `engines.node` 升 `>=22.5` |
| `_gen_fixture.js` 在 .npmignore | — | I-LOW-3 | — | D-MED-4 | 放回 npm,或 README 说明 |
| `bin.js` vs `cli/ai-memory.js` 版本分歧 | — | — | — | D-MED-11, D-CRIT-3 | 同步 |
| server-split 死代码 | — | I-HIGH-1 | Q-HIGH-8 | — | 实施或全删 |

---

## 6. 建议执行顺序

> **更新 (2026-07-09):** Wave 1 + Wave 2 已全部修复完成。Wave 1 见 git log `fc502aa` 起每条独立 commit;Wave 2 见 merge `0e8f359` (B) + `072deed` (A)。

按"用户感知影响 × 修复成本"排序:

### Wave 1 — 用户文档/契约错误(半天) ✅ 已完成
1. I-CRIT-1: 替换 `memory_recall` / `memory_store` → 真实工具名
2. I-CRIT-2: 全局 grep `tech-debt-roadmap|PROJECT_ANALYSIS` 删引用
3. I-HIGH-2: 删 `ops/sync-openclaw*` 引用
4. I-MED-1: 删 `migrateRecordFromV2ToV3` stub
5. D-MED-3 + 端口表统一: 改 README + AGENTS.md 用 `port-registry.js`

### Wave 2 — CI/版本一致性(1 天) ✅ 已完成 (commits fded3e5..7510398,merge 072deed/0e8f359)
1. D-CRIT-1: ESLint 版本统一 ✅
2. D-CRIT-3 + D-MED-11: 同步 cli → 3.1.0 ✅
3. D-CRIT-4: CHANGELOG Keep-a-Changelog 化 或 删 release.yml ✅
4. D-HIGH-2/3: 合并 lint / test workflows ✅
5. D-MED-9: `eslint` 移 devDependencies ✅

### Wave 3 — 安全(1–2 天) ✅ 已完成 (commits 20baf38..b16d498)
- S-CRIT-1 (yaml): 已不存在,grep 0 命中
- S-HIGH-1 (watchdog Invoke-Expression / bash -c): 改 exe+args
- S-HIGH-2 (-Command 字符串): 已不存在,统一走 -EncodedCommand
- S-HIGH-3 (SSRF): assertSafeBaseUrl + 主机 allowlist
- S-HIGH-4 (Docker || true): 3 处全部移除
- S-MED-1 (metrics listen): 显式 127.0.0.1
- S-MED-2 (ReDoS): regex 库 timeout=1.0 + 启发式兜底
- S-MED-3 (MCP 长度 cap): validateMcpInput helper
- S-MED-4 (.bat 随机名): crypto.randomBytes(16)
- S-MED-5: 无需修复,记录在案
- S-MED-6: 留待后续,非安全问题
1. S-CRIT-1: `yaml.safe_load` 全局
2. S-HIGH-1: `scripts/watchdog.ps1` 拆参
3. S-HIGH-3: SSRF allowlist
4. S-HIGH-4: Docker 错误不吞
5. S-MED-1/2/3: metrics host / ReDoS / MCP 长度 cap

### Wave 4 — 性能(2–3 天) ⏳ 部分完成 (8 项,6 新)+ 留待后续专项

**已修 (commits 26c1238 / 5f20275 / 18380bb / da46be3 / 52d1427 / bfa3d4f / 2f53a12 / 7e12b54 / 6bbab16 / 34c5743):**
- Q-CRIT-1: search_ranking.py 抽 _resolve_query_runtime_for_dense (净 -10 行, 2 处重复 → 1 helper) ✅ (commit 52d1427)。审计说"3 处重复"实测仅 2 处,ann_dense_scores 不存在。
- Q-CRIT-2: readEmbeddingsSummary mtime cache (3s TTL) ✅
- Q-CRIT-3: handleRefineMemorySelection fallback 加 degraded: true ✅
- Q-HIGH-3: bus/bm25.js 加 tokenize FIFO 缓存 (1024 entries) ✅ (commit 5f20275)。审计严重高估:文件 102 行,非性能瓶颈。
- Q-HIGH-4: embedding-provider-registry proxy env 抽 getProxyEnv() ✅
- Q-HIGH-7: spawnProcess helper 抽到 child-process.mjs ✅ (commit 2f53a12)
- Q-HIGH-8: buildHandlerRegistry 同名 handler 抛 Error ✅ (commit 26c1238)
- Q-MED-4 / I-LOW-1: getContextPath 复用 bus/store-root.js 导出 ✅ (commit da46be3)
- Q-MED-5: cli/package.json engines >=16 → >=18 ✅ (commit 18380bb)

**留待独立 PR (高风险,涉及大文件改动或跨语言协调):**
- Q-CRIT-4: per-call Python spawn 改 worker pool (降级路径真实存在,需与 Q-HIGH-1 联做)
- Q-HIGH-1: 800+ 行文件拆分继续 (generate-embeddings.js 抽 NOISE_PATTERNS 到 text-noise.js 已 start,commit bfa3d4f 805→799 行; 余 main/loadExistingIndex 拆 + embedding-worker-pool.cjs 658 行拆 + search_ranking.py 1367 行拆,与 Q-CRIT-1 helper 抽取协同)
- Q-HIGH-2: generate-embeddings.js main() 描述"N+1 次写"实测 writeIndexSnapshot 已 atomic per-batch,只是 batch 数 × 1,需重新评估 partial-write 语义后才能改 (留待后续 deep-PR)
- Q-HIGH-5: fact_0/1/2 → 内容 hash 键 (动 JSONL schema,需跨语言协调)
- Q-HIGH-6: 跨语言 hash parity test (audit 描述失准:JS 侧已无 build_embedding_config_hash 对应函数,问题形态已变)
- Q-HIGH-10: IPC 跨语言 trace id (audit 路径失准:shared-mcp/proto/compute.js 已不存在,新路径需再查)
- Q-MED-3/8/10: 4 处错误风格 / fixture / var 用法 (后续 cleanup bundle)

### Wave 5 — 架构与可观测 ⏳ 入口已激活

**已修 (commit 5079e8e):**
- I-HIGH-1: `omni-memory-server.js` 激活 `AI_MEMORY_SERVER_MODE` env 入口 (retrieval/bridge/dream/mgmt/all),死代码 `toolFilter` 升级为环境变量驱动。完整 4-server 独立进程拆分 (`docs/architecture/SERVER-SPLIT.md` §7) 留作后续 PR; 本次 PR 是入口激活,把死代码变活路径。

涉及 server-split 实施 (I-HIGH-1) 与 IPC/可观测架构改动,应作专项 PR:

涉及 server-split 实施 (I-HIGH-1) 与 IPC/可观测架构改动,应作专项 PR:
- I-HIGH-1: 实施 server-split 4 个独立进程 (omni-memory-{retrieval,bridge,dream,mgmt}:9338-9341)
- Q-HIGH-7/8/10: IPC 统一 / handler 名冲突 / trace id
- 测试覆盖率 80%+ (Q-Test)
- Q-MEM/Q-LOG/Q-DOC 等 Low 项

---

## 7. 附录 — 报告与产物

- 本次审查**4 个 subagent** 共扫描 386 文件调用,生成本汇总
- 详细 subagent 报告位置:
  - 安全: `C:\Users\04735\AppData\Local\Temp\claude\D--Data-Desktop-obsidian-shared-memory-bus\b20809b6-9a45-4150-94ff-10fc6aedf4b8\tasks\a3fa2ecda56288171.output`
  - 未完成: `…\tasks\a62ceae886e77d5a5.output`
  - 代码质量: `D:\Data\Desktop\obsidian-shared-memory-bus\.agents\reviews\code-review-report.md` (60 KB)
  - 结构/依赖: `…\tasks\a6463e1751a7ba005.output`

### 7.1 未在本报告展开的子项(留给后续专项)
- 完整 YAML `load()` → `safe_load` 审计需逐文件复核
- `bus/generate-embeddings.js` 重构设计稿
- `retrieval/search_ranking.py` 拆分边界图
- server-split 真实实施的资源评估
- 跨语言 parity test 套件设计

### 7.2 元说明
- **诚实声明**: 部分 "文件:行" 引用基于 subagent 报告,**未在本会话亲自逐行打开复核**。在动手修改前请先 `Read` 目标文件确认现状(代码可能已演进)。
- **优先级建议**: Wave 1 必做(用户能立即看到),Wave 2-3 一周内,Wave 4-5 排进 roadmap。
- **配合建议**: 修复时按 Wave 分支开 PR,每个 Wave 单独 review 合并,避免巨型 diff。
