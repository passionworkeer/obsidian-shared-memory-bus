# Q-HIGH-1 step 5 — `search_ranking.py` + `semantic_search.py` 拆分设计稿

> 状态: **草案**,待 review。
> 来源: `docs/PROJECT_AUDIT_2026-07-09-RECONCILE.md:41-44` (Q-HIGH-1) + `:31-34` (Q-CRIT-1 协同)、Explore 子 agent 报告 (2026-07-10)。
> 续 step 1-4:`bfa3d4f` text-noise / `3702de5` buildWorkerScript / `b63ce02` loadExistingIndex / `ebee78d` text-utility.js。

---

## 1. 问题陈述

### 1.1 行数超规

| 文件 | 行数 | 项目红线 (CLAUDE.md §代码质量) |
|---|---:|---:|
| `retrieval/search_ranking.py` | 1357 | < 800 |
| `retrieval/semantic_search.py` | 971 | < 800 |

### 1.2 名字与职责错位

`search_ranking.py` 文件名暗示"只做排名",**实际承担的职责有 8 类**(参考 Explore §1 报告):

1. BM25 评分 (`bm25_scores`、`get_bm25_model`、`keyword_overlap_scores`)
2. Dense / cosine scoring (`cosine_similarity`、`embed_query`、`dense_scores`、`_resolve_query_runtime_for_dense` 等 ~7 函数)
3. Query 路由(`task_state_weight`、`score_entry`、`classify_query_intent`、`build_query_route`、`analyze_query_type`、`compute_adaptive_blend_weights`、`apply_field_match_bonus`)
4. Reranking (`_cross_encoder_rerank`、`rerank_entries`、`mmr_rerank`)
5. **Tokenization + text utilities**(`_ensure_jieba`、`tokenize`、`normalize_spaces`、`is_noise`、`derive_entry_layer` + 6 个常量/正则: `NOISE_PATTERNS` / `STRUCTURED_FILES` / `DURABLE_SCOPES` / `ROUTE_VALUES` / `KNOWN_LAYERS` / 4 个 query 正则)
6. Score normalization / fusion(`normalize_score_map`、`compute_rank_map`、`rrf_fusion_score`、`resolve_fusion_mode`、`ranked_pairs`)
7. **Cache helpers** + 4 个全局可变 dict(`prune_timed_cache`、`build_query_embedding_cache_key`、`get_cached_query_embedding`、`store_query_embedding` + `_BM25_CACHE` / `_QUERY_EMBEDDING_CACHE` / `_SEARCH_RESULT_CACHE` / `_CACHE_METRICS`)
8. **Structured-files loader**(`_load_structured_files` + `_STRUCTURED_FILES_FALLBACK`)

BM25 + Dense + 路由 + Rerank + Score fusion 五类评分/路由核心,实际只占文件 ~1/3。

`semantic_search.py` 也类似:971 行里 ~150 行是 **snippet extraction** (`build_snippet_terms` / `extract_snippet_window` / `extract_verbatim_snippets`),~180 行是 **memory-drift / temporal utilities** (`parse_timestamp_seconds` / `calculate_age_days` / `temporal_decay_score` / `check_memory_drift`)。

### 1.3 现状

原 `retrieval/semantic-search.py` (~2117 行) 已经按 5 模块拆分过:`search_ranking` / `search_index` / `search_cache` / `search_server` / `semantic_search`(`semantic_search.py:14-15` docstring 原文)。这一步大致完成。但**剩下的两个文件自身又长大了**。

`retrieval/REFACTOR-NOTES.md` 已丢失(两个文件 docstring 仍引用 "See retrieval/REFACTOR-NOTES.md"),原计划的"剩余"部分无从核对。

---

## 2. 拆分目标

- 让 `search_ranking.py` 收敛到 **"rank + route + rerank + fusion"** 单一职责(< 800 行)。
- 让 `semantic_search.py` 收敛到 **"CLI entry + orchestration + filter/format"**(< 800 行)。
- 不改变任何对外契约 — 任何 import 路径 / `from search_ranking import (...)` 列表 / JSONL CLI 行为 / 测试断言, **byte-identical**。
- 不改算法 — 仅做职责重排。
- 与**所有 5 个下游消费者**保持 ABI 兼容。

---

## 3. 拆分方案

### 3.1 `search_ranking.py` 拆分

**抽出(迁到新文件)**:

| 迁出符号 | 新文件 | 大约行数 |
|---|---|---:|
| `_ensure_jieba`、`tokenize`、`normalize_spaces`、`is_noise`、`derive_entry_layer` | `retrieval/search_text_utils.py` | ~110 |
| `NOISE_PATTERNS`、`STRUCTURED_FILES`/`_STRUCTURED_FILES_FALLBACK`、`DURABLE_SCOPES`、`ROUTE_VALUES`、`KNOWN_LAYERS`、4 个 query 正则 (`RECENT_QUERY_PATTERN` 等) | `retrieval/search_text_utils.py` | ~50 |
| `_load_structured_files` | `retrieval/search_text_utils.py` | ~10 |
| `prune_timed_cache`、`build_query_embedding_cache_key`、`get_cached_query_embedding`、`store_query_embedding` + 4 个全局 dict (`_BM25_CACHE` / `_QUERY_EMBEDDING_CACHE` / `_SEARCH_RESULT_CACHE` / `_CACHE_METRICS`) + 4 个 `_CACHE_TTL` / `_QUERY_EMBEDDING_CACHE_TTL` / `_SEARCH_RESULT_CACHE_TTL` / `_BM25_CACHE_MAX_ENTRIES` / `_QUERY_EMBEDDING_CACHE_MAX_ENTRIES` 常量 | `retrieval/search_query_cache.py` | ~150 |

**保留(`search_ranking.py` 内)**:
- BM25 + Dense + Rerank + Route + Fusion:预计从 1357 减到 **~650 行**(`/5:6 + 公开重导出 ~100`)。
- 所有"对外契约" 符号 (39 个) re-export via `from search_text_utils import (...); from search_query_cache import (...)`,保持 `from search_ranking import (...)` 不破。

**文件结构**:

```
retrieval/
├── search_ranking.py        (≤ 800 行)  ← BM25/dense/route/rerank/fusion + re-export
├── search_text_utils.py     (~200 行)   ← tokenize/is_noise/normalize/structured-files 常量+loader
└── search_query_cache.py    (~150 行)   ← query-embed cache + 4 个全局缓存 dict
```

### 3.2 `semantic_search.py` 拆分

**抽出**:

| 迁出符号 | 新文件 | 大约行数 |
|---|---|---:|
| `parse_timestamp_seconds`、`calculate_age_days`、`temporal_decay_score` | `retrieval/search_temporal.py` | ~80 |
| `check_memory_drift` | `retrieval/search_temporal.py` | ~60 |
| `build_snippet_terms`、`extract_snippet_window`、`extract_verbatim_snippets` | `retrieval/search_snippets.py` | ~130 |

**保留(`semantic_search.py` 内)**:
- CLI entry (`parse_args`、`main`)+ orchestration (`execute_search`、`normalize_request_payload` + `apply_filters` + `format_results` + `apply_summary_boost` + `build_bm25_cache_key`)
- 预计从 971 减到 **~650 行**。

**文件结构**:

```
retrieval/
├── semantic_search.py       (≤ 800 行)  ← CLI + orchestration
├── search_temporal.py       (~140 行)   ← timestamp/age/decay/drift
└── search_snippets.py       (~130 行)   ← snippet extraction
```

### 3.3 整体新结构

```
retrieval/
├── semantic_search.py            (971 → ~650)  CLI/orchestration
├── search_ranking.py             (1357 → ~650) scoring/routing/rerank/fusion
├── search_text_utils.py          (新, ~200)   tokenize + constants + structured-files
├── search_query_cache.py         (新, ~150)   query-embed cache + 4 globals
├── search_temporal.py            (新, ~140)   timestamp/age/drift
├── search_snippets.py            (新, ~130)   snippet extraction
├── search_index.py               (existing, 565) index/entries/cache mgmt
├── search_cache.py               (existing)  cache strategy/persistent layer
├── search_server.py              (existing)  JSONL server
└── ann_index.py                  (existing)  ANN index
```

---

## 4. 下游消费者影响

| 文件 | 现 import | 拆后影响 |
|---|---|---|
| `retrieval/semantic_search.py` | `from search_ranking import (...)` 39 个名字 | `search_ranking.py` 保留所有 re-export,不受影响 |
| `retrieval/search_index.py` | `from search_ranking import tokenize, normalize_spaces, is_noise, derive_entry_layer, NOISE_PATTERNS, STRUCTURED_FILES` + 3 共享缓存 dict | re-export 保持,**改名取决于 search_index.py 是否迁到 search_text_utils**;3 共享 dict 留在 search_query_cache |
| `retrieval/search_cache.py` | `from search_ranking import normalize_spaces, prune_timed_cache, _QUERY_EMBEDDING_CACHE, _SEARCH_RESULT_CACHE, _BM25_CACHE, _CACHE_METRICS` | re-export 保持 |
| `retrieval/search_server.py` | `from search_ranking import (...)` | re-export 保持 |
| `retrieval/benchmark_qps.py` | `from search_ranking import bm25_scores, normalize_score_map` | re-export 保持 |
| `tests/unit/py/test_search_cache.py` | `importlib.util.spec_from_file_location("search_ranking", ...)` | **重点关注**:file-path 直接 import,sys.modules 注入;若 search_ranking 后续从 search_text_utils 引了新东西,spec 路径不变即可 |
| `tests/cross-language/shared-config-parity.test.js` | 子进程调 `from search_ranking import STRUCTURED_FILES` | re-export 保持 |
| `benchmark-backends.py`, `eval-routing.py`, `eval/judgments-generator.js`, `semantic-search.js`, `semantic-search-cli.test.js` | 全走 `python semantic_search.py` CLI / 文件路径常量 | **仅文件路径常量可能变**(CLI 入口仍为 `semantic_search.py`,无影响) |

### 4.1 循环 import 边界

> `search_cache.py:215` 与 `search_server.py:106/133/186/279` 都有 *"Deferred import to avoid circular dependency with semantic_search.py"* 的延迟 import。
> → **不要拆 `execute_search` / `parse_args` / `main` 到独立文件**,否则破坏现有边界。`semantic_search.py` 留作"CLI + orchestration 入口 + 调度循环"。

---

## 5. 落地 commit 划分

按 Q-HIGH-1 历史 step 节奏(step 1 → 4 都是单 commit 单职责),本 step 5 拆为 **5 个 commit**,每个独立可回滚:

| # | Commit | 范围 | 行数 | 风险 |
|---|---|---|---:|---|
| 1 | `refactor(retrieval): step 5.1 抽 tokenize/text utils → search_text_utils.py` | search_ranking.py L47/L98-165/L200 + constants + structured-files loader | ~+250/-200 | 低(语义无变化,纯模块化) |
| 2 | `refactor(retrieval): step 5.2 抽 query-embed cache → search_query_cache.py` | search_ranking.py L72-91/L218/L389-418 + 4 缓存 dict | ~+170/-150 | 低-中(共享全局 dict,re-export 一定带) |
| 3 | `refactor(retrieval): step 5.3 抽 snippet extraction → search_snippets.py` | semantic_search.py L322-456 (`build_snippet_terms`/`extract_snippet_window`/`extract_verbatim_snippets`) | ~+150/-130 | 低 |
| 4 | `refactor(retrieval): step 5.4 抽 temporal/drift → search_temporal.py` | semantic_search.py L277-308/L458-514 (`parse_timestamp_seconds`/`calculate_age_days`/`temporal_decay_score`/`check_memory_drift`) | ~+150/-140 | 低 |
| 5 | `test(retrieval): step 5.5 cross-module 守护 + 行数回归断言` | 新守护测试 (见 §6) | ~+200 | 低 |

**总行数估计**:~+920 / -620 净 +300,**比 REC §9.3 "Q-HIGH-1 大文件余下 ~400" 略高,因包含新文件框架代码 + 测试**。

### 5.1 commit 顺序约束

- step 5.1 必须先于 5.2(同 search_ranking.py 内,先抽出无状态 utility,再抽带全局状态的 cache)
- step 5.3 / 5.4 互相独立,可并行(都从 `semantic_search.py` 抽出,无相互依赖)
- step 5.5 必须在 5.1-5.4 全部完成后

---

## 6. 测试覆盖矩阵

| 现有测试 | 改动 | 拆后归属 |
|---|---|---|
| `tests/unit/py/test_search_cache.py` (search_ranking import test) | 路径不变;**spec_from_file_location** 仍指向 `search_ranking.py`,re-export 必须保留 | **新增断言**: `from search_ranking import tokenize is normalize_spaces is is_noise` 三个 import 重新 re-export 自 search_text_utils |
| `tests/cross-language/shared-config-parity.test.js` (subprocess `from search_ranking import STRUCTURED_FILES`) | re-export 保留 | **新增断言**:从 search_text_utils 取的也工作 |
| 没有的: search_text_utils / search_query_cache / search_snippets / search_temporal 单元测试 | **新增** | step 5.1-5.4 每个 commit 自带 > 80% 覆盖的 unit test(`test_search_text_utils.py`、`test_search_query_cache.py`、`test_search_snippets.py`、`test_search_temporal.py`) |
| 没有的: 行数守护 | **新增 step 5.5** | `test_search_ranking_linecount.py` + `test_semantic_search_linecount.py` 锁 `wc -l < 800` |

### 6.1 不重写测试

CLAUDE.md §3 "Surgical Changes" — **不得重写现有测试,只能补。** `test_search_cache.py` / `shared-config-parity.test.js` 任何 assertion **byte-identical**,只在测试本身补 import-re-export 断言。

---

## 7. 风险与回滚

### 7.1 风险矩阵

| 风险 | 影响范围 | 缓解 |
|---|---|---|
| 5 下游消费者 ABI 破坏 | `search_index` / `search_cache` / `search_server` / `benchmark_qps` / `test_search_cache.py` / `shared-config-parity.test.js` | re-export 层完整保留 39 个对外契约;每个 commit 后跑 `python -c "import search_ranking"` + 全量 py 测试 |
| 共享全局缓存 dict 的"身份迁移" | `search_index.py:51` 直接引用 `_BM25_CACHE` 等对象(同 dict 跨模块) | dict 实例保持在 search_query_cache.py;从 search_ranking re-export 的同一个 dict(用 `from search_query_cache import _BM25_CACHE; __all__ = [..., "_BM25_CACHE"]`),**引用同一对象** 而非副本 |
| 循环 import | `search_cache.py:215` / `search_server.py` 延迟 import | 不拆 `execute_search` / `main` / `parse_args`;不改 omni-handlers style 边界 |
| 测试路径依赖 | `test_search_cache.py` 用 file_location spec | 不变;只在 re-export 阶段确认 symbol 都还在 |
| 命名冲突 | Q-HIGH-1 step 1 (`text-noise.js`) 是 Node 端,本 step 5.1 是 Python 端,无冲突 |

### 7.2 回滚策略

- 每个 commit 独立 revert: `git revert <commit>` 后 `python semantic_search.py "test query"` 必须仍能跑(5 commit 任何一个 revert 都不破 wire)。
- step 5.5 行数守护若 fire,直接回退对应 step 的抽取 commit。

---

## 8. 立项 checklist

- [ ] review 本文,获 maintainer 同意开工
- [ ] step 5.1: 抽 tokenize/text utils + re-export + test_search_text_utils.py — 测试全绿
- [ ] step 5.2: 抽 query-embed cache + re-export + test_search_query_cache.py — 测试全绿
- [ ] step 5.3: 抽 snippet extraction + re-export + test_search_snippets.py — 测试全绿
- [ ] step 5.4: 抽 temporal/drift + re-export + test_search_temporal.py — 测试全绿
- [ ] step 5.5: line-count 守护 + 5 commit 后总 `wc -l` 验证
- [ ] 更新 `docs/CHANGELOG.md` / `docs/PROJECT_AUDIT_2026-07-09-RECONCILE.md` 标 step 5 done
- [ ] close Q-HIGH-1 + Q-CRIT-1 留待项 (如适用)

---

## 9. 相关

- `docs/PROJECT_AUDIT_2026-07-09-RECONCILE.md:41` Q-HIGH-1 原文
- `docs/PROJECT_AUDIT_2026-07-09-RECONCILE.md:31` Q-CRIT-1 协同 (本 step 5.1 顺带可处理 `_resolve_query_runtime_for_dense` 的 helper 复用问题,但 Q-CRIT-1 已 commit `796c9f4` 处理;**不再二次抽**)
- step 1-4 commit: `bfa3d4f` / `3702de5` / `b63ce02` / `ebee78d`
- CHANGELOG §Q-HIGH-1 step 5 待补
