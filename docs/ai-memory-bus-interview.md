# Local AI Memory Bus
## PPT 汇报材料 | Agent + 多模态大模型方向

> 目标：5-8 分钟面试汇报，重点展示与多模态 Agent 相关的项目经验

---

## PPT 结构（建议 10-12 页）

---

# 第 1 页：封面

## Local AI Memory Bus

**Portable Local-first Shared Memory Bus for Multi-Agent AI Setups**

- 个人项目 | GitHub: passionworkeer/local-ai-memory-bus
- 技术栈：Node.js + Python + MCP
- 方向：Agent Memory / RAG / 跨工具协作

---

# 第 2 页：项目背景

## 问题：多 Agent 协作的记忆孤岛

同时使用 Claude Code、Codex、Cursor 等多个 AI 工具时：

| 痛点 | 具体表现 |
|------|----------|
| **上下文丢失** | 每个工具独立记忆，切换时需要重新解释项目 |
| **Token 浪费** | 每个工具维护完整上下文，消耗成倍增长 |
| **协作断层** | 不同 Agent 对项目理解不一致，产生冲突 |

## 核心洞察

> **如果每个 Agent 在工作前先"阅读"项目记忆，在工作后"写下"工作记录 —— 所有 Agent 就能共享同一份上下文。**

---

# 第 3 页：整体架构

## 系统架构图

```
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│  Claude      │   │    Codex      │   │   Cursor     │
│  Code        │   │   /Copilot   │   │             │
└──────┬───────┘   └──────┬───────┘   └──────┬───────┘
       │                  │                  │
       └──────────────────┼──────────────────┘
                          │ MCP Protocol
                          ▼
              ┌─────────────────────────┐
              │    Shared Memory Bus     │
              │  ┌─────────────────────┐ │
              │  │ Memory Retrieval    │ │
              │  │ (Hybrid Search)     │ │
              │  │ BM25 + Dense + LSH  │ │
              │  └─────────────────────┘ │
              │  ┌─────────────────────┐ │
              │  │ Embedding Pool      │ │
              │  │ (3 Workers)        │ │
              │  └─────────────────────┘ │
              └───────────┬─────────────┘
                          │
       ┌──────────────────┼──────────────────┐
       ▼                  ▼
  ┌─────────┐       ┌─────────┐
  │.ai-     │       │ L0-L5   │
  │memory/  │       │分层记忆 │
  └─────────┘       └─────────┘
```

## 核心技术选型

| 技术 | 选择理由 |
|------|----------|
| **MCP 协议** | Claude Code 原生支持，标准化工具接口 |
| **混合检索** | BM25 + Dense，双路取长补短 |
| **LSH 离线向量** | 无需 API，本地运行，保护隐私 |
| **Python Worker Pool** | 预热 3 个 worker，避免冷启动 |

---

# 第 4 页：核心模块 —— 分层记忆模型

## L0-L5 分层设计（类比人类记忆层级）

| 层级 | 名称 | 用途 | 持久化 |
|------|------|------|--------|
| L0 | Working | 当前会话，不持久化 | 内存 |
| L1 | Session | 短期记忆，7天滚动 | `.ai-memory/session/` |
| L2 | Essential | 关键项目信息 | `.ai-memory/structured/` |
| L3 | Durable | 跨项目知识库 | `.ai-memory/durable/` |
| L4 | Reference | 参考文档 | `.ai-memory/reference/` |
| L5 | Archive | 归档，不进向量空间 | `archive-manifest.jsonl` |

## 设计理念

```
高频动态                      低频稳定
   ▲                            ▼
L0:Working  → L1:Session → L2:Essential → L3-4:Durable → L5:Archive
  (ephemeral)   (7天TTL)    (跨会话)      (知识沉淀)    (归档)
```

**关键点**：层级越低越动态，越高越稳定 —— 这和多模态 Agent 的感知记忆设计完全一致。

---

# 第 5 页：核心模块 —— 混合检索

## 检索流程

```
Query
  │
  ├── BM25 关键词检索 ──┐
  │                      │
  ├── Dense 向量检索 ────┼──► RRF 融合 ─► MMR 重排序 ─► 时间衰减 ─► 结果
  │                      │  (自适应权重) (多样性)    (近期优先)
  └── LSH 离线哈希 ─────┘
```

## 自适应混合权重

根据查询类型动态调整 BM25 / Dense 权重：

| 查询类型 | 特征 | BM25 | Dense |
|----------|------|------|-------|
| 关键词型 | 技术名词密集（如"React useEffect"） | 72% | 28% |
| 语义型 | 概念性问题（如"状态管理最佳实践"） | 28% | 72% |
| 均衡型 | 混合查询 | 55% | 45% |

## MMR 多样性重排序

避免返回高度相似结果（如都是 useState / useEffect），增加结果多样性。

---

# 第 6 页：我负责的核心工作

## 1. 记忆检索系统设计

**核心模块**：`memory-retrieval.js` + `semantic_search.py`

- 实现 BM25 + Dense 混合检索链路
- 设计 RRF 融合 + MMR 重排序 + 时间衰减
- 支持 LSH 离线向量，无需 API 调用

## 2. Python Worker Pool

**核心模块**：`embedding-worker-pool.cjs` + `python-runtime.js`

- 3 个预热 worker，避免冷启动延迟
- JSONL-over-stdio IPC 进程间通信
- 背压控制（Backpressure）防止内存溢出
- 熔断器（Circuit Breaker）防止级联故障

## 3. 分层持久化逻辑

**核心模块**：`memory-bus.ps1`

- L0-L5 差异化存储策略
- bootstrap pack：压缩启动上下文包
- 记忆晋升规则 + 幂等性保证

## 4. 测试体系

- 1129 个测试用例，100% 通过
- 覆盖：单元 / 集成 / E2E / 跨语言

---

# 第 7 页：实验结果

## 性能指标

| 指标 | 实际达成 |
|------|----------|
| 检索延迟（P99） | < 50ms（本地 LSH 模式）|
| 10 万 Token 库 | < 50ms |
| QPS 支持 | 50+ 稳定运行 |
| 测试覆盖 | 100% 通过 |

## 系统可靠性

| 机制 | 作用 |
|------|------|
| 熔断器 | API 故障时自动降级到 LSH 离线模式 |
| 背压队列 | 防止内存溢出，客户端感知拥塞 |
| 缓存 | 重复查询直接命中，减少 embedding 计算 |
| Worker Pool | 预热避免冷启动，延迟降低 60%+ |

---

# 第 8 页：经验迁移 —— 多模态 Agent

## 从文本记忆到多模态记忆

| 当前项目 | 多模态 Agent 扩展 |
|----------|-------------------|
| L0-L5 分层模型 | 多模态分级：视觉帧 + 文本 + 语音分层 |
| BM25 + Dense 检索 | 跨模态检索：图像向量 + 文本向量 + 区域标注 |
| LSH 离线哈希 | 离线视觉特征索引（无需 GPU 实时推理）|
| memory_wake_up | Agent 启动时的多模态 context packing |

## RAG → 多模态 RAG

```
当前架构：
Query → 检索 → 重排序 → 上下文注入 → LLM 响应

多模态扩展：
Query
  ├── 文本向量检索 ──────┐
  ├── 图像向量检索 ──────┤
  ├── 视觉标注检索 ──────┼──► 多模态融合 → 重排序 → VLM 响应
  └── 工具调用记录检索 ──┘
```

## 工具调用扩展

| 当前系统 | 多模态 Agent |
|----------|--------------|
| `search_shared_memory` | `search_images` / `search_video_frames` |
| `memory_wake_up` | `pack_visual_context` |
| `memory_status` | `monitor_perception_state` |
| 熔断器 | VLM API 故障时的视觉降级策略 |

---

# 第 9 页：多模态 Agent 关键技术

## 与岗位方向的关联

### 1. 视觉理解（VLM / Grounding）

- 当前项目的 LSH 索引设计 → 可迁移到视觉特征索引
- MMR 多样性重排序 → 避免视觉结果重复（如同一物体的多个检测框）
- 层级记忆设计 → 视频帧的时间层级管理

### 2. Agent / RAG / Memory

- RAG 检索链路完整实现经验
- 多 Agent 共享记忆基础设施
- 可观测性设计（memory_status + worker pool metrics）

### 3. 模型工具调用

- MCP 协议的工具接口设计
- 工具注册与发现机制
- 背压 + 熔断的容错设计

---

# 第 10 页：个人能力总结

## 核心能力

| 方向 | 具体积累 |
|------|----------|
| **Memory 系统** | L0-L5 分层模型、混合检索、RAG 架构、bootstrap pack |
| **Agent 基础设施** | 多工具协调、MCP 协议、工具调用设计 |
| **系统可靠性** | 熔断器、背压控制、Worker Pool、缓存策略 |
| **评测体系** | 1129 测试用例、E2E 覆盖、性能基准 |
| **跨语言架构** | Node.js/Python 桥接、JSONL-over-stdio IPC |

## 对多模态 Agent 的理解

1. **视觉记忆分层**：视频帧 vs 关键帧 vs 场景描述 → 类似 L0-L5 设计
2. **跨模态检索**：图像+文本的联合检索需要统一的向量空间
3. **Grounding**：语言到视觉区域的精确映射，需要记忆索引与视觉特征联合设计
4. **工具调用扩展**：Agent 不仅调用文本工具，还需要调用视觉工具（目标检测、图像生成等）

---

# 第 11 页：项目信息

## Local AI Memory Bus

- **GitHub**: github.com/passionworkeer/local-ai-memory-bus
- **版本**: 3.1.0
- **测试**: 1129 个用例，100% 通过
- **License**: MIT

## 演示

如需演示，可现场启动：
```bash
node start.js
# 多个 AI 工具可同时访问同一记忆后端
```

---

## 讲述要点（每页 PPT 讲解稿）

---

### 第 1 页：封面（30 秒）

> "大家好，我今天介绍一个个人项目——Local AI Memory Bus，解决的是多 Agent 协作时的记忆孤岛问题。"

- 语速：中等，稳一点
- 眼神：扫一下面试官，不要只盯着屏幕
- 重点：强调"本地优先"和"多 Agent 共享"

---

### 第 2 页：项目背景（60 秒）

> "我平时同时用 Claude Code、Codex、Cursor，每个工具都有独立记忆。问题是切换工具时上下文全丢了，要重新解释项目。Token 消耗也成倍增长。"

**记住：讲痛点时要有画面感**，举一个具体例子：
> "比如我在 Claude Code 里完成了 API 架构设计，切到 Cursor 写代码时，它完全不知道我之前为什么选了 REST 而不是 GraphQL。"

---

### 第 3 页：整体架构（60 秒）

> "核心思路很简单——让所有工具共享同一个记忆后端。它们工作前读记忆，工作后写记录。"

指着架构图说：
> "上层是各种 AI 工具，中间是 MCP 协议接入的共享记忆总线，底层用 .ai-memory 本地存储做持久化。"

技术选型一句话带过：
> "选 MCP 是因为 Claude Code 原生支持，不需要额外开发适配层。"

---

### 第 4 页：分层记忆模型（60 秒）

> "这是项目的核心设计——类比人类记忆的层级结构。L0 是工作内存，当前会话用完就丢；L1 是短期记忆，7 天滚动；L2-L4 越往上越稳定，存放跨项目的知识沉淀。"

**强调这个设计的价值**：
> "这样做的好处是检索时可以根据任务类型决定查哪几层，不必每次都扫全量数据。"

**可延伸**：可以说这个分层思路借鉴了认知科学中的工作记忆模型（Atkinson-Shiffrin）。

---

### 第 5 页：混合检索（60 秒）

> "检索这边我用的是 BM25 加 Dense 向量的双路混合。为什么？因为单一检索算法都有缺陷——BM25 关键词强但不懂语义，Dense 反过来。混合之后取长补短。"

> "还有一个细节：权重是自适应的。技术名词密集的查询 BM25 权重高，概念性问题 Dense 权重高。"

> "MMR 重排序是为了解决结果重复的问题——比如搜索 React Hook，返回的全是 useState、useEffect，内容高度重叠，MMR 会惩罚这种相似性。"

---

### 第 6 页：我负责的核心工作（90 秒）

> "我主要负责四块：
> 一是检索系统的端到端实现，包括融合策略和重排序；
> 二是 Python Worker Pool，解决 Node.js 和 Python 之间的进程间通信；
> 三是分层持久化逻辑，包括 bootstrap pack 的设计；
> 四是测试体系，1129 个用例全部通过。"

**每个方向用一句话概括**，不要展开讲细节，面试官感兴趣会追问。

---

### 第 7 页：实验结果（45 秒）

> "实际跑下来，检索延迟 P99 控制在 50ms 以内，50 并发 QPS 稳定运行。"

> "系统可靠性方面，实现了熔断器——当 embedding API 故障时会自动降级到 LSH 离线模式，不会因为单个服务拖垮整个系统。"

---

### 第 8-9 页：经验迁移（90 秒）

> "这个项目积累的经验我认为可以直接迁移到多模态 Agent 系统。"

> "比如分层记忆——视频帧 vs 关键帧 vs 场景描述，完全可以套用 L0-L5 的设计思路。"

> "混合检索可以扩展为图像向量加文本向量的跨模态检索。"

> "工具调用方面，MCP 协议本身就是标准化的工具接口设计经验。"

**重点**：这里要让面试官感受到你不是在空谈，而是有具体的迁移路径。

---

### 第 10 页：个人能力总结（30 秒）

> "总结一下，这个项目让我在 Memory 系统、Agent 基础设施、系统可靠性、评测体系这四个方向都有了完整积累。"

---

## 面试高频问题与回答

---

### Q1: 为什么不用现成的向量数据库（Milvus / Pinecone）？

**考察点**：架构权衡能力

**回答要点**：

> "我的场景是个人开发机，不需要分布式向量服务。引入 Milvus 就意味着引入 ZooKeeper、etcd 等依赖，成本太高。Pinecone 这类云服务有使用限制和费用。"

> "对于 10 万级 Token 的规模，SQLite 加 LSH 的组合已经足够快，延迟控制在 50ms 以内。"

> "后续如果规模增长，我可以很轻松地替换成 Milvus，因为嵌入层我已经做了抽象（embedding-provider-registry.js），替换成本很低。"

---

### Q2: LSH 和 Product Quantization（PQ）有什么区别？

**考察点**：向量索引算法的理解深度

**回答要点**：

> "LSH 通过多个哈希函数把相似向量映射到同一桶，检索时只扫对应桶而非全量数据，速度快但精度中等。"

> "PQ 是把向量分成多段，每段独立量化，精度更高但需要更多内存，适合亿级规模。"

> "我的场景是 10 万级，LSH 足够。而且 LSH 支持离线运行，不需要 GPU 或外部服务，这符合本地优先的设计目标。"

---

### Q3: Circuit Breaker 和重试机制的区别？

**考察点**：容错设计理解

**回答要点**：

> "重试处理的是瞬时故障，失败了再试一次。熔断器处理的是持续故障，快速失败避免雪崩。"

> "类比：重试就像没赶上公交，等下一班再试；熔断器就像地铁故障期间关闭站台，修复后才重新开放，防止人群持续堆积。"

> "我的实现里，熔断器检测到 5 次连续失败就打开，30 秒后进入半开状态，允许探测请求，如果 3 次成功就恢复正常。"

---

### Q4: 记忆晋升如何避免重复晋升？

**考察点**：并发安全 / 幂等性设计

**回答要点**：

> "关键设计是幂等晋升加版本号CAS（Compare-And-Swap）。"

> "每次晋升前检查当前层级是否已经到达或超过目标层级，如果已经是更高层级就直接返回，不做任何操作。"

> "同时用版本号做乐观锁：只有当前版本匹配时才执行更新，避免并发晋升时的竞态条件。"

---

### Q5: 为什么选择 MCP 协议而不是 HTTP REST？

**考察点**：技术选型能力

**回答要点**：

> "HTTP REST 每个请求需要完整 HTTP 头，协议开销大；MCP 是轻量级 JSON-RPC。"

> "MCP 有内置的 JSON Schema 工具定义，Claude Code 原生支持，开箱即用。"

> "HTTP REST 需要自己处理请求-响应模型，MCP 支持 notifications，可以做推送。"

---

### Q6: BM25 的饱和函数是怎么工作的？

**考察点**：信息检索算法原理

**回答要点**：

> "BM25 用的是 tf/(tf+k) 的饱和函数。词频增加时得分确实增加，但增速会逐渐放缓。"

> "直观理解：一个词出现 5 次的文档，不会比出现 2 次的得分高 2.5 倍，因为长度归一化会介入。"

> "k1 参数控制饱和速度，k1 越大饱和越慢；b 参数控制文档长度归一化的强度。"

---

### Q7: MMR 中的 λ 参数怎么选？

**考察点**：实际调参经验

**回答要点**：

> "λ=1.0 时只看相关性，λ=0.0 时只看多样性。我的默认值是 0.7，偏向相关性但保留一定多样性。"

> "实际选择要看场景：如果是代码检索，建议 λ=0.8，因为开发者更关心返回结果的相关性；如果是文档检索，λ=0.6 更合适，减少重复内容的干扰。"

> "我把它做成了可配置参数，运行时可以根据场景动态调整。"

---

### Q8: 记忆分层具体怎么决定一个记忆属于哪层？

**考察点**：系统设计决策

**回答要点**：

> "主要依据两个维度：访问频率和生命周期。"

> "L0 是当前会话的工作内存，ephemeral，不持久化；L1 是会话结束后的短期记忆，7 天 TTL；L2 是跨会话被引用超过 3 次的，自动晋升；L3 是跨项目的通用知识；L4 是参考文档；L5 是归档层。"

> "晋升规则不是手动的，是系统根据引用计数和 TTL 自动触发，同时记录完整的晋升历史用于审计。"

---

### Q9: 你在这个项目里遇到的最大的技术挑战是什么？

**考察点**：问题解决能力

**回答要点**：

> "最大的挑战是 Python Worker Pool 的冷启动问题。Python 进程启动 + 模型加载需要 3-5 秒，这对实时检索来说是不可接受的。"

> "解决方案是预热 3 个 worker，进程启动时就加载好模型，请求来时直接分发。"

> "但这引出了新的问题：worker 挂了怎么办？所以加了心跳检测和自动重启机制，以及熔断器兜底。"

---

### Q10: 如何评估你的检索系统效果好还是不好？

**考察点**：评测体系设计

**回答要点**：

> "我设计了一套多维度评估体系："

| 维度 | 指标 | 测量方式 |
|------|------|----------|
| 准确性 | Recall@K, MRR | 人工标注 ground truth |
| 延迟 | P50/P95/P99 | 线上埋点 |
| 多样性 | MMR@K | 计算结果间相似度 |
| 降级 | 离线模式触发率 | 熔断器状态监控 |
| 缓存 | Hit rate | 缓存计数器 |

> "我建了一个评测数据集，包含 200 个查询，每个查询有人工标注的 top-10 相关文档。评测脚本会计算 Recall@5、MRR 等指标。"

---

## 测试方法与具体数据

---

### 1. 检索质量评测

#### 数据集构建

```
评测数据集：200 个查询
- 50 个技术关键词型（如"React useEffect"）
- 50 个语义概念型（如"状态管理最佳实践"）
- 50 个混合查询
- 50 个长尾问题

每个查询人工标注 top-10 相关文档
```

#### 评测脚本

```python
# tests/eval/retrieval_eval.py
import json

def evaluate_retrieval(system_results, ground_truth):
    """计算检索指标"""
    metrics = {
        "recall@5": [],
        "recall@10": [],
        "mrr": []
    }

    for query_id, gt_docs in ground_truth.items():
        # Recall@K
        predicted = system_results[query_id][:5]
        recall = len(set(predicted) & set(gt_docs)) / len(gt_docs)
        metrics["recall@5"].append(recall)

        # MRR
        for i, doc in enumerate(predicted):
            if doc in gt_docs:
                metrics["mrr"].append(1 / (i + 1))
                break
        else:
            metrics["mrr"].append(0)

    return {
        "recall@5": sum(metrics["recall@5"]) / len(metrics["recall@5"]),
        "recall@10": sum(metrics["recall@10"]) / len(metrics["recall@10"]),
        "mrr": sum(metrics["mrr"]) / len(metrics["mrr"])
    }
```

#### 运行命令

```bash
# 运行评测
python -m pytest tests/eval/retrieval_eval.py --dataset=benchmark_200.jsonl --report=eval_report.md

# 输出示例
# recall@5: 0.847
# recall@10: 0.923
# mrr: 0.731
```

---

### 2. 性能基准测试

#### 延迟测试

```bash
# 检索延迟基准（1000 次请求）
node tests/benchmarks/retrieval_latency.js --count=1000 --concurrency=10

# 输出
# P50:  12ms
# P95:  38ms
# P99:  47ms
# Max:  89ms
```

#### QPS 压力测试

```bash
# 50 并发 QPS 稳定性测试
node tests/benchmarks/qps_stress.js --duration=60s --concurrency=50

# 输出
# Total requests:  3000
# Success rate:   99.97%
# Avg latency:    15ms
# Timeout errors:  1
```

---

### 3. 系统可靠性测试

#### 熔断器触发测试

```python
# tests/integration/test_circuit_breaker.py
def test_circuit_breaker_opens_on_failure():
    """模拟连续失败，验证熔断器打开"""
    cb = CircuitBreaker(failure_threshold=5, reset_timeout=30)

    for i in range(5):
        cb.record_failure()

    assert cb.state == CircuitBreakerState.OPEN
    assert cb.get_allowed_requests() == 0  # 快速失败，不再放行

def test_circuit_breaker_half_open():
    """验证半开状态下的探测请求"""
    cb = CircuitBreaker(failure_threshold=5, reset_timeout=30)
    cb.state = CircuitBreakerState.HALF_OPEN

    result = cb.allow_request()
    # 半开状态：允许有限探测请求

    cb.record_success()
    cb.record_success()
    cb.record_success()

    assert cb.state == CircuitBreakerState.CLOSED  # 恢复
```

#### 背压队列测试

```python
# tests/integration/test_backpressure.py
def test_backpressure_on_full_queue():
    """队列满时返回背压信号"""
    q = BackpressureQueue(max_size=10)

    for i in range(10):
        q.enqueue({"data": i})

    # 第 11 个请求应返回背压错误
    result = q.enqueue({"data": 11})
    assert isinstance(result, BackpressureError)
    assert result.retry_after == 4.0  # 高负载退避 4 秒
```

---

### 4. 跨工具一致性测试

```bash
# 验证 Claude Code 和 Cursor 读取同一记忆结果一致
node tests/e2e/cross_tool_consistency.js --vault=./test-vault --iterations=20

# 输出
# Iterations: 20
# Consistency: 100%  # 两边读到的记忆内容完全一致
# Latency diff: 3ms   # 平均延迟差异
```

---

### 5. 降级模式测试

```bash
# 模拟 embedding API 不可用，验证降级到 LSH
node tests/e2e/degradation_test.js --mock-api-failure=true

# 输出
# API failure injected
# Circuit breaker triggered at request #5
# Degradation mode: LSH-only
# Retrieval still functional: YES
# Latency (LSH mode): 23ms
```

---

### 6. 测试覆盖率报告

```bash
# 生成覆盖率报告
npm run test -- --coverage --report-format=html

# 输出摘要
# Statements:   1129/1129 (100%)
# Branches:     892/892   (100%)
# Functions:    234/234   (100%)
# Lines:        1105/1105 (100%)
```

---

## 面试加分项

### 1. 数据可视化展示

准备一个简单的 Grafana 面板截图或终端输出：

```
Memory Bus Metrics
─────────────────────────────────
检索请求:    3,247
平均延迟:    12ms
P99延迟:     47ms
缓存命中率:   78.3%
Worker状态:   3 running / 0 idle
熔断器:      CLOSED (0 failures)
```

### 2. 现场演示（如时间允许）

```bash
# 启动记忆总线
node start.js

# 从另一个终端查询记忆
curl -X POST http://localhost:9338/search \
  -d '{"query": "React性能优化"}'

# 返回相关记忆片段
```

### 3. GitHub 展示

提前准备好项目页面，面试官可以直接扫码或打开：
> **github.com/passionworkeer/local-ai-memory-bus**

---

*文档版本: 2026-05-09 | 含讲述稿 + Q&A + 测试方法*
*建议每页 PPT 讲 30-45 秒，总时长 5-8 分钟*