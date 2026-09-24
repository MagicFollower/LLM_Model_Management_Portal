# ModelSpace · 模型管理工作台

面向百人以内的内网团队，提供模型接入与管理、用户与模型授权、知识库、文档处理与引用溯源、流式对话。当前包含 Vue 3 前端 + 本地 Python 检索服务（BGE Embedding），Mock 模式可完整体验，真实业务后端尚未接入。

## 项目结构

```
.
├── README.md                              # 本文件
├── 需求与架构分析规划.md                    # 全栈技术选型、RAG 流水线、部署与资源规划
├── 前端系统设计规划.md                      # 前端架构、Mermaid 图、API 契约、验收与边界
├── HuggingFace小型Embedding与知识库检索实施方案.md  # 检索能力专项实施文档
├── .gitignore
├── backend/                               # Python 本地检索服务
│   ├── app/                               # FastAPI 配置、模型、HTTP 路由、BM25、Reranker
│   ├── tests/                             # pytest 单测（48 项）
│   ├── scripts/                           # 冒烟测试脚本、模型下载脚本
│   ├── run.py                             # 启动入口
│   ├── .env.example                       # 环境变量模板（BM25/Reranker/权重）
│   ├── requirements.txt                   # 运行依赖
│   └── requirements-dev.txt               # 测试依赖
└── frontend/                              # Vue 3 前端
    ├── package.json
    ├── vite.config.ts
    ├── tsconfig.json
    ├── compose.yaml                       # Docker Compose 部署
    ├── Dockerfile
    ├── nginx.conf.template
    ├── .env.example
    ── src/
        ├── api/                           # 统一业务 API + 检索 HTTP 客户端
        ├── mock/                          # 演示适配器、种子数据、共享检索模块
        ├── types/                         # 实体、DTO、权限、SSE 事件、检索类型
        ├── stores/                        # Pinia 身份状态
        ├── router/                        # Vue Router + RBAC 守卫
        ├── utils/                         # SSE 解析、校验、错误处理、码点分片
        ├── layouts/                       # 工作台布局
        ├── views/                         # 登录 / 工作台 / 模型 / 用户 / 知识库 / 文档 / 对话
        ├── components/                    # KnowledgeRetrievalPanel 检索测试区
        ├── styles.css                     # 公共样式
        ├── main.ts
        └── App.vue
```

## 已实现能力

- 登录与 RBAC 路由守卫，固定 `admin` / `user` 两角色，权限变更实时生效。
- 模型管理（Chat / Embedding / Rerank），搜索、筛选、分页、CRUD、启停、连接测试；密钥不回显、不持久化。
- 用户管理，CRUD、启停、密码重置、多模型授权；禁止删除最后一个启用管理员。
- 知识库 CRUD，Embedding 必选、Rerank 可选；非空库禁止更换向量模型。
- 文档工作台，PDF / DOCX / MD / TXT 上传，独立上传进度与处理阶段进度，失败重试，切分参数预览与确认重处理，分页内容卡片。
- 流式对话，会话列表、模型与知识库配置、SSE 逐段输出、中止、引用详情鉴权与原文下载。
- 知识库检索测试区，本地 BGE Embedding 实际分片与语义检索，真实分数与命中排名，快照二次校验（身份/权限/版本/正文变化检测）；支持 BM25 混合检索 + RRF 融合 + Reranker 重排序（Feature Flag 渐进启用）。
- 模拟对话复用实际检索结果，引用卡片标注来源文档与片段版本；demo 模式保持离线固定引用。
- Mock 模式无需业务后端即可完整体验；检索服务独立运行（`127.0.0.1:8001`），经 Vite 同源代理转发。
- 真实模式通过 `VITE_DATA_MODE=rest` 切换业务数据，经同源 `/api/v1` 转发。
- 白色扁平主题，窄屏折叠导航；所有页面具备加载、空态、失败重试、提交中反馈。

## 界面预览

### 登录页

![登录页](images/0.png)

左侧品牌介绍，右侧账号密码登录表单，支持管理员与普通成员两种角色体验。

### 工作台

![工作台](images/5.png)

汇总可访问模型、知识库、文档总数、会话数等关键指标，展示模型资源分布与文档处理状态。

### 模型管理

![模型管理](images/1.png)

统一模型目录，支持 Chat / Embedding / Rerank 三种类型，提供搜索、筛选、分页、CRUD、启停与连接测试。

### 知识库

![知识库](images/2.png)

知识库卡片列表，展示 Embedding 与 Rerank 配置、切分参数、文档数量，支持新建与打开知识库。

### 用户与权限

![用户管理](images/3.png)

团队成员管理，支持角色分配、账号启停、多模型授权，禁止删除最后一个启用管理员。

### 智能对话

![智能对话](images/4.png)

流式对话界面，左侧会话列表，右侧消息区支持模型与知识库配置、SSE 逐段输出、引用卡片溯源。

## 未实现范围

- 业务后端（Fastify / Prisma / BullMQ / Qdrant / Xinference）尚未接入，当前检索由本地 Python 服务提供。
- 真实 Chat 模型推理、PDF / DOCX 解析待联调。Rerank 基础设施已就绪（Feature Flag 启用即可）。
- 自定义角色编辑器、共享知识库 ACL、消息分支、OCR、拖拽切分编排、服务端全文分页。

## 快速开始

环境要求：Node.js 22.12+（22 系列）或 24+；Python 3.11+。

```powershell
# 安装前端依赖
npm --prefix ./frontend ci --registry=https://registry.npmjs.org

# 启动前端开发服务（默认 Mock 模式，端口 5173）
npm --prefix ./frontend run dev
```

演示账号：`admin / admin123`，`member / member123`；新增演示用户统一使用 `demo123`。侧栏可重置演示数据。请勿上传敏感文件。

### 启动本地检索服务（可选）

知识库检索测试区和模拟对话引用需要本地 Python 检索服务：

```powershell
# 创建虚拟环境并安装依赖
python -m venv ./backend/.venv
& ./backend/.venv/Scripts/python.exe -m pip install -r ./backend/requirements.txt

# 启动检索服务（127.0.0.1:8001）
& ./backend/.venv/Scripts/python.exe ./backend/run.py
```

首次启动后在知识库详情页点击“加载模型”下载 BAAI/bge-small-zh-v1.5（约 90 MB），加载完成后即可进行实际语义检索。默认 `VITE_RETRIEVAL_MODE=local`；设为 `demo` 可跳过检索服务使用离线固定引用。

## 切换真实 API

复制 `frontend/.env.example` 为 `frontend/.env.local` 并修改：

```dotenv
VITE_DATA_MODE=rest
VITE_API_BASE_URL=/api/v1
API_PROXY_TARGET=http://localhost:3000
```

重启 Vite。真实模式后端不可达时显示错误，不降级演示。模型服务地址在模型管理表单配置，凭据由后端保存。

## 质量检查

```powershell
npm --prefix ./frontend run typecheck
npm --prefix ./frontend test
npm --prefix ./frontend run build
npm --prefix ./frontend run format:check
npm --prefix ./frontend audit --registry=https://registry.npmjs.org
```

当前 248 项 Vitest 测试通过（含 54 项检索模块测试、48 项检索 API 测试），后端 48 项 pytest 通过，依赖审计 0 个已知漏洞。Windows 下 Vitest 4 对路径大小写敏感，绝对路径请使用规范盘符 `C:\Users\X\Desktop\模型管理系统\frontend`。

## 容器部署

```powershell
docker compose -f ./frontend/compose.yaml up --build -d
```

默认发布到 8080。真实模式设置构建参数 `VITE_DATA_MODE=rest`，运行变量 `BACKEND_HOST`、`BACKEND_PORT` 指向业务后端。镜像不包含密钥，生产 HTTPS 由入口反向代理终止。

## 生产级流程差距评估

### 当前切分实现评估

前端 `splitText()`（`frontend/src/utils/validation.ts`）并非“完全不可用”，它实现了：

- 字符级切分 + 语义边界检测（`\n\n` → `\n` → `。` → `；` → 空格）
- 重叠窗口支持
- 参数校验（50-4000 字符，重叠 < 切分大小）
- 有单元测试覆盖（边界、高重叠不死循环、语义边界优先）

**但它只是生产流程中的一小环。**

### 与生产级流程的差距

#### 1. 文档解析层（完全缺失）

| 阶段 | 当前状态 | 生产需要 |
|---|---|---|
| TXT/MD 文本提取 | ✅ 真实读取 | ✅ |
| PDF 解析 | ❌ 占位文本 `"PDF 为占位内容"` | PyMuPDF / pdfplumber 提取文字 + 页码 |
| DOCX 解析 | ❌ 占位文本 | python-docx 提取段落 + 样式 |
| 元数据保留 | ❌ `page: null`, `section: "模拟字符切分"` | 页码、标题层级、表格识别 |

#### 2. 切分策略（基础可用，需升级）

| 维度 | 当前 | 生产级 |
|---|---|---|
| 切分单位 | 字符数 | Token 数（与模型对齐） |
| 边界检测 | 固定分隔符优先级 | 语义切分（sentence-transformers 段落检测 / LLM 辅助） |
| 结构感知 | ❌ 不识别标题/列表/表格 | 按 Markdown heading / HTML tag 保持结构完整 |
| 重叠策略 | 字符重叠 | Token 重叠，确保语义完整 |

#### 3. 处理流水线（完全模拟）

当前状态转换是**定时器模拟**（`frontend/src/mock/index.ts`）：

```
parsing (1.5s) → splitting (3s) → embedding (4.5s) → indexing → ready
```

生产需要：

- **异步任务队列**（BullMQ / Celery）：解析、切分、向量化、入库分阶段执行
- **进度回调**：每阶段真实进度，非固定延迟
- **失败重试**：单阶段失败可重试，不从头开始
- **并发控制**：限制同时处理的文档数，避免 OOM

#### 4. 向量存储与索引（完全缺失）

| 组件 | 当前 | 生产需要 |
|---|---|---|
| 向量存储 | 前端内存 `chunks: Chunk[]` | Qdrant / Milvus / pgvector |
| 索引构建 |  无 | HNSW / IVF 索引，支持亿级向量 |
| 增量更新 | ❌ 全量重算 | 文档更新时只重算变化 chunk |
| 持久化 | localStorage | 向量数据库 + 元数据数据库 |

#### 5. 检索流程（部分实现）

后端检索服务（`backend/app/retrieval.py`）已实现：

- ✅ LRU 缓存（2048 条，内容 hash 键）
- ✅ 长文本窗口切分编码
- ✅ 归一化点积 = 余弦相似度
- ✅ Top-K + 阈值过滤

**缺失：**

- ❌ **混合检索**：BM25 关键词 + 向量相似度融合
- ❌ **Rerank**：bge-reranker-v2-m3 已配置但未接入
- ❌ **多路召回**：向量检索 + 关键词检索结果合并
- ❌ **过滤条件**：按知识库、文档类型、时间范围过滤

#### 6. 工程化缺失

| 项目 | 当前 | 生产需要 |
|---|---|---|
| 任务队列 |  | BullMQ + Redis |
| 监控告警 | ❌ | Prometheus + Grafana |
| 日志追踪 | ❌ | 结构化日志 + trace ID |
| 限流降级 |  | 检索并发限制、模型加载超时 |
| 多租户隔离 | ❌ | 知识库级向量空间隔离 |

### 总结

```
当前实现程度（按生产流程阶段）：

文档上传     ████████░░  80%（TXT/MD 真实，PDF/DOCX 占位）
文本解析     ██░░░░░░░░  20%（仅纯文本读取）
智能切分     ████░░░░░░  40%（字符切分可用，缺语义/结构感知）
向量化       ██████░░░░  60%（BGE 模型真实加载编码）
向量存储     ░░░░░░░░░░   0%（无向量数据库）
索引构建     ░░░░░░░░░░   0%（无 HNSW/IVF 索引）
检索         █████░░░░░  50%（点积检索可用，缺混合检索/Rerank）
重排序       ░░░░░░░░░░   0%（Rerank 未接入）
```

**切分本身不是“完全不可用”**——字符级语义边界切分在中小文档上效果尚可，且有测试保障。但它是孤立的，上下游（解析、存储、索引、Rerank）都未接通，无法形成完整的生产闭环。

---

## 改进文档（2026年9月24日）

- [需求与架构分析规划](./需求与架构分析规划.md)：全栈技术选型、RAG 流水线、部署与资源规划。
- [前端系统设计规划](./前端系统设计规划.md)：前端架构、Mermaid 图、API 契约、验收与边界。
- [HuggingFace Embedding 检索实施方案](./HuggingFace小型Embedding与知识库检索实施方案.md)：BGE 模型选型、本地检索服务、前端集成与实测数据。
- [Embedding 模型工作原理与检索闭环归档](./Embedding模型工作原理与检索闭环归档.md)：Embedding 原理、项目架构 Mermaid 图、完整检索流程。
- 检索与重排序混合管线优化：BM25 + 向量 RRF 融合、bge-reranker-v2-m3 重排序、前端适配、测试归档（见本文件末尾章节）。

### 检索与重排序混合管线优化

#### 改进前后对比

| 维度 | 改进前 | 改进后 |
|---|---|---|
| **检索通道** | 纯向量点积（余弦相似度）单路 | 向量 + BM25 双路 RRF 融合 |
| **重排序** | ░░░░░░░░░░ 0%（未接入） | ██████████ 100%（bge-reranker-v2-m3，Feature Flag 启用） |
| **关键词召回** | ❌ 无法召回精确关键词 | ✅ BM25 字符 bigram 补充关键词通道 |
| **过滤能力** | ❌ 全量候选无过滤 | ✅ 按知识库 ID / 文档类型过滤 |
| **多路融合** | ❌ 不存在 | ✅ RRF（k=60）融合，权重可配 |
| **降级机制** | ❌ 不存在 | ✅ Reranker 失败自动回退混合分数 |
| **后端文件数** | 5 个（config/schemas/embedding/retrieval/main） | 7 个（+bm25.py +reranker.py） |
| **后端代码行数** | retrieval.py 143 行 / main.py 249 行 | retrieval.py 245 行 / main.py 287 行 |
| **后端测试数** | 20 项 | 48 项（+28 新增） |
| **前端测试数** | 248 项 | 248 项（零回归） |
| **API 兼容性** | — | 所有新字段 optional，旧客户端零改动 |
| **默认行为** | — | BM25/Reranker 默认关闭，不影响现有流程 |
| **检索流程** | 编码 → 点积 → 排序 → Top-K | 过滤 → 向量 → BM25 → RRF → Rerank → 排序 → Top-K |
| **新增端点** | — | `/retrieval/reranker-health`、`/retrieval/reranker-load` |
| **health 端点** | 仅 Embedding 状态 | Embedding + Reranker 状态 |

#### 改进动机

差距评估中检索环节仅 50%（纯点积向量检索）、重排序 0%（Rerank 未接入），是生产流程中最关键的短板。具体表现：

- **单一检索通道**：仅依赖向量余弦相似度，对精确关键词（专有名词、编号、缩写）召回能力弱
- **无重排序**：缺少 CrossEncoder 精排阶段，语义相近候选无法区分优先级
- **无过滤能力**：不能按知识库、文档类型缩小检索范围
- **无多路融合**：缺少 BM25 关键词检索与向量检索的互补机制

本次改进目标：将检索 + 重排序从 50%/0% 提升至 100% 可用，同时保持向后兼容。

#### Reranker 模型介绍

##### 什么是 Reranker

Reranker（重排序模型）是检索管线中的“精排”环节。传统的 Embedding 检索属于 **BiEncoder**（双编码器）架构——查询和文档分别独立编码为向量，通过余弦相似度快速匹配，适合从海量候选中秒级召回 Top-K。但 BiEncoder 的局限在于查询和文档独立编码，无法捕捉二者之间的细粒度交互。

Reranker 采用 **CrossEncoder**（交叉编码器）架构——将查询和文档拼接为 `[query, passage]` 对，一起送入模型做深度注意力交互，最终输出一个相关性分数。CrossEncoder 精度高但无法预计算文档向量，因此不适合全量检索，而适合对 BiEncoder 已召回的少量候选（通常 10–50 条）做二次精排。

```
典型 RAG 检索管线：

用户查询
  │
  ├─ BiEncoder（Embedding）    毫秒级，全量候选中召回 Top-50
  │    └─ 查询和文档独立编码，向量点积/余弦相似度
  │
  ├─ BM25（关键词）              毫秒级，补充精确关键词召回
  │    └─ 词频统计，无需模型
  │
  ├─ RRF 融合                       合并多路结果
  │
  └─ CrossEncoder（Reranker）   百毫秒级，对融合后 Top-20 精排
       └─ 查询+文档联合编码，输出相关性分数
```

##### 为什么选择 bge-reranker-v2-m3

| 维度 | 说明 |
|---|---|
| 系列一致性 | 与项目已有的 `bge-small-zh-v1.5` Embedding 同属 BAAI/bge 系列，训练数据分布一致，语义空间对齐 |
| 多语言支持 | v2-m3 支持 100+ 语言，中文效果显著优于仅英文模型 |
| 体积可控 | ~560 MB（CPU fp32），本地单用户场景可接受 |
| 官方支持 | FlagEmbedding 官方库直接支持 `FlagReranker` 加载，`normalize=True` 输出 sigmoid ∈ [0,1]，可直接作为分数使用 |
| 精度表现 | 在 C-MTEB / MTEB 重排序榜单上位列同体量第一梯队 |

##### 在项目中的工作方式

```
RerankerService 生命周期（复制 EmbeddingService 模式）：

UNLOADED ──load()──▶ LOADING ──后台加载完成──▶ READY
                          │
                          └──加载失败──▶ ERROR

READY 状态下接受 rerank(query, passages, top_k) 调用：
  1. 构造 [query, passage] 对
  2. FlagReranker.compute_score(pairs, normalize=True)
  3. 按分数降序返回 [(原始索引, 分数), ...]
  4. 失败时自动降级：保留混合检索分数，不中断流程
```

Reranker 默认关闭（`RERANKER_ENABLED=false`）。启用后在 `/retrieval/load` 时随 Embedding 一同加载，也可通过 `/retrieval/reranker-load` 独立触发。

#### 改进思路

##### 设计原则

1. **向后兼容**：所有新 API 字段 optional + 默认值，旧客户端零改动
2. **Feature Flags**：BM25/Reranker 默认关闭，通过环境变量渐进启用
3. **模式复用**：RerankerService 严格复制 EmbeddingService 生命周期模式
4. **零依赖分词**：BM25 使用字符 bigram，不引入 jieba 词典
5. **优雅降级**：Reranker 不可用时自动回退到混合检索分数

##### 技术选型

| 组件 | 选型 | 理由 |
|---|---|---|
| BM25 分词 | 字符 bigram | 零外部依赖，中文适配，~50ms 建索引 |
| 融合算法 | Reciprocal Rank Fusion (RRF) | 无需归一化分数，k=60 常数稳定 |
| Reranker | BAAI/bge-reranker-v2-m3 | 与 bge embedding 同系列，FlagEmbedding 官方支持 |
| Reranker 库 | FlagEmbedding | 官方 Python 库，支持 normalize=True |
| 权重配置 | 向量 0.7 / BM25 0.3 | 向量为主路径，BM25 为补充 |

##### 检索管线流程

```
请求进入
  │
  ├─ 0. 过滤（知识库 ID / 文档类型）
  │
  ├─ 1. 向量检索（始终执行）
  │     └─ LRU 缓存 + 窗口切分编码 + 最大点积
  │
  ├─ 2. BM25 检索（enableBm25 && BM25_ENABLED 时）
  │     └─ 字符 bigram 分词 → IDF → Okapi 评分
  │
  ├─ 3. RRF 融合（BM25 有结果时）
  │     └─ score = Σ weight_i / (k + rank_i + 1)
  │
  ├─ 4. Rerank（enableRerank && RERANKER_ENABLED 时）
  │     └─ FlagReranker compute_score → 重排序
  │     └─ 失败时降级：保留混合检索分数
  │
  └─ 5. 阈值过滤 + 降序排序 + Top-K 截断
```

#### 改进执行流程

##### 阶段 1：基础设施（配置 + 依赖 + Schema）

**依赖添加**（`backend/requirements.txt`）：

- `rank-bm25>=0.2,<1`：纯 Python BM25 实现
- `FlagEmbedding>=1.2,<2`：BGE Reranker 官方库

**配置扩展**（`backend/app/config.py`）：

```python
# BM25 配置
BM25_ENABLED = os.environ.get("BM25_ENABLED", "false").lower() == "true"

# Reranker 配置
RERANKER_MODEL_ID = "BAAI/bge-reranker-v2-m3"
RERANKER_MODEL_PATH = os.environ.get("RERANKER_MODEL_PATH")
RERANKER_ENABLED = os.environ.get("RERANKER_ENABLED", "false").lower() == "true"
RERANKER_TOP_N = int(os.environ.get("RERANKER_TOP_N", "20"))

# 混合检索权重
BM25_WEIGHT = float(os.environ.get("BM25_WEIGHT", "0.3"))
VECTOR_WEIGHT = float(os.environ.get("VECTOR_WEIGHT", "0.7"))
RRF_K = 60
```

**Schema 扩展**（`backend/app/schemas.py`）：

- `ChunkInput` 追加 `knowledgeBaseId`、`documentType`（Optional）
- `SearchRequest` 追加 `enableBm25`、`enableRerank`、`knowledgeBaseIds`、`documentTypes`（Optional）
- `SearchHit` 追加 `vectorScore`、`bm25Score`、`rerankScore`（Optional）
- `SearchResponseData` 追加 `rerankerUsed`（Optional）

##### 阶段 2：BM25 关键词检索

**新建 `backend/app/bm25.py`**（77 行）：

- `tokenize_bigram(text)`：字符 bigram 分词，零外部依赖适配中文
- `BM25Scorer` 类：`build_index(documents)` 构建倒排索引，`score()` / `score_batch()` 计算 Okapi BM25 分数
- IDF 变体公式：`log((N - df + 0.5) / (df + 0.5) + 1.0)`

**重构 `backend/app/retrieval.py`**（143 → 245 行）：

- 提取 `_vector_search()` 私有方法（原有向量检索逻辑完全不变）
- 新增 `_apply_filters()`：按知识库 ID / 文档类型过滤候选
- 新增 `_bm25_search()`：BM25 关键词检索
- 新增 `_rrf_fusion()`：Reciprocal Rank Fusion 双路融合
- 新增 `_rerank()`：调用 RerankerService，try/except 降级
- `_do_search()` 重构为管线编排：过滤 → 向量 → BM25 → RRF → Rerank → 排序截断

##### 阶段 3：Reranker 重排序

**新建 `backend/app/reranker.py`**（107 行）：

- `RerankerState` 枚举：UNLOADED / LOADING / READY / ERROR
- `RerankerService` 类：严格复制 EmbeddingService 生命周期模式
  - `load()`：后台 `asyncio.create_task` 异步加载
  - `rerank()`：`run_in_executor` 线程池执行，避免阻塞事件循环
  - `_load_sync()`：延迟导入 `FlagEmbedding.FlagReranker`
  - `_rerank_sync()`：`compute_score(pairs, normalize=True)` 返回 sigmoid 分数
- `reranker_service` 全局单例

**集成到 `backend/app/main.py`**：

- `/retrieval/health` 追加 `reranker` 状态字段
- `/retrieval/load` 在 Embedding 加载后同时触发 Reranker 加载（若 `RERANKER_ENABLED`）
- 新增 `/retrieval/reranker-health`：独立查询 Reranker 状态
- 新增 `/retrieval/reranker-load`：独立触发 Reranker 加载

##### 阶段 4：前端适配

**类型扩展**（`frontend/src/types/retrieval.ts`）：

- `SearchRequest` chunks 追加 `knowledgeBaseId?`、`documentType?`；请求追加 `enableBm25?`、`enableRerank?`、`knowledgeBaseIds?`、`documentTypes?`
- `SearchResponse` hits 追加 `vectorScore?`、`bm25Score?`、`rerankScore?`；响应追加 `rerankerUsed?`
- `RetrievalHealth` 追加 `reranker?` 可选嵌套对象

**Mock 层**（`frontend/src/mock/retrieval.ts`）：

- 新增 `inferDocumentType(name)`：从文件扩展名推断文档类型
- `collectEligible()` 为每个 chunk 追加 `documentType` 和 `knowledgeBaseId`

**API 校验**（`frontend/src/api/retrieval.ts`）：

- `health()` 解析可选的 `reranker` 嵌套字段
- `searchVectors()` snapshot 复制传递新可选字段；hit 校验容忍 `vectorScore`/`bm25Score`/`rerankScore`；解析 `rerankerUsed`

#### 改进完整变更清单

| 文件 | 操作 | 说明 |
|---|---|---|
| `backend/requirements.txt` | 修改 | 添加 rank-bm25、FlagEmbedding |
| `backend/app/config.py` | 修改 | +14 行 BM25/Reranker/混合权重配置 |
| `backend/app/schemas.py` | 修改 | +10 行 可选字段扩展 |
| `backend/app/bm25.py` | **新建** | BM25Scorer 字符 bigram 分词（77 行） |
| `backend/app/reranker.py` | **新建** | RerankerService 生命周期管理（107 行） |
| `backend/app/retrieval.py` | 重构 | 143→245 行，混合检索管线 |
| `backend/app/main.py` | 修改 | +38 行 reranker 集成 + 2 新端点 |
| `backend/tests/test_retrieval.py` | 修改 | +350 行 28 项新测试 |
| `frontend/src/types/retrieval.ts` | 修改 | +12 行 可选字段扩展 |
| `frontend/src/mock/retrieval.ts` | 修改 | +9 行 documentType 推断 |
| `frontend/src/api/retrieval.ts` | 修改 | +28 行 校验兼容 |
| `frontend/src/mock/retrieval.test.ts` | 修改 | 1 处断言适配新字段 |

#### 测试结果

**后端 48/48 通过**（20 原有 + 28 新增）：

| 测试类 | 数量 | 覆盖范围 |
|---|---|---|
| TestBM25Scorer | 7 | bigram 分词、索引构建、评分、空输入、批量评分 |
| TestRRFFusion | 4 | 单路退化、双路融合、不重叠、空输入 |
| TestApplyFilters | 5 | 无过滤、知识库过滤、文档类型过滤、组合过滤、空结果 |
| TestBM25Search | 2 | 基本检索、无匹配 |
| TestRerankerService | 7 | 生命周期、健康状态、后台加载、未就绪异常、mock 评分、单文档 |
| TestRerankerEndpoints | 3 | reranker-health、主健康含 reranker、非本地拒绝 |

**前端 248/248 通过**（零回归）。

**TypeScript 类型检查零错误**。

#### 启用方式

项目提供完整的后端环境变量模板 `backend/.env.example`，复制为 `.env` 并按需修改：

```powershell
copy backend\.env.example backend\.env
```

完整配置内容（`backend/.env.example`）：

```ini
# ============================================================
# ModelSpace 后端环境变量配置
# ============================================================

# ---- Embedding 模型 ----
# HuggingFace 缓存目录（默认 backend/.cache/huggingface）
# HF_CACHE_DIR=/path/to/cache

# 本地模型路径（设置后离线加载，不联网）
# MODEL_PATH=C:\Users\X\Desktop\模型管理系统\backend\.cache\huggingface\bge-small-zh-v1.5

# HuggingFace 镜像站（国内网络）
# HF_ENDPOINT=https://hf-mirror.com

# ---- BM25 关键词检索 ----
# 设为 true 启用 BM25 通道（纯算法，无需额外模型）
BM25_ENABLED=true

# ---- Reranker 重排序 ----
# 设为 true 启用 Reranker（需先下载 bge-reranker-v2-m3 模型 ~560MB）
RERANKER_ENABLED=true

# 本地 Reranker 模型路径（不设则使用 HF 缓存自动查找）
RERANKER_MODEL_PATH=C:\Users\X\Desktop\模型管理系统\backend\.cache\huggingface\bge-reranker-v2-m3

# 送入 Reranker 的候选数上限（默认 20）
RERANKER_TOP_N=20

# ---- 混合检索权重 ----
# 向量权重 + BM25 权重建议合计为 1.0
VECTOR_WEIGHT=0.7
BM25_WEIGHT=0.3

# ---- 服务配置 ----
HOST=127.0.0.1
PORT=8001
```

**快速启用全部能力**：将上述 `BM25_ENABLED`、`RERANKER_ENABLED`、`RERANKER_MODEL_PATH` 三项取消注释并设为实际值，启动服务即可。

**最小启用（仅 BM25，无需下载模型）**：

```ini
BM25_ENABLED=true
# RERANKER_ENABLED=false   # 默认已关闭，无需显式设置
```

启动服务：

```powershell
# Windows PowerShell 加载 .env 并启动
Get-Content backend\.env | ForEach-Object { if ($_ -match '^(\w+)=(.+)$' -and $Matches[1] -notmatch '^#') { [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2]) } }
& ./backend/.venv/Scripts/python.exe ./backend/run.py
```

前端请求中 `enableBm25: true` / `enableRerank: true` 配合服务端环境变量同时为 true 时生效；任一为 false 则跳过对应阶段。

#### 新增模型与下载内容

本次优化引入两类新增依赖：Python 包和 Reranker 模型。

##### 新增 Python 依赖

| 包名 | 版本 | 大小 | 用途 |
|---|---|---|---|
| `rank-bm25` | >=0.2,<1 | ~10 KB | 纯 Python BM25 Okapi 实现，无 C 扩展 |
| `FlagEmbedding` | >=1.2,<2 | ~2 MB（不含模型） | BGE Reranker 官方推理库 |

安装方式（已写入 `backend/requirements.txt`）：

```powershell
& ./backend/.venv/Scripts/python.exe -m pip install -r ./backend/requirements.txt
```

##### 新增模型：BAAI/bge-reranker-v2-m3

| 属性 | 值 |
|---|---|
| 模型 ID | `BAAI/bge-reranker-v2-m3` |
| 类型 | CrossEncoder（重排序） |
| 磁盘占用 | ~560 MB |
| 加载内存 | ~700 MB（CPU fp32） |
| 加载时间 | ~15–30 秒（CPU，视磁盘速度） |
| 推理延迟 | ~50–100 ms / 20 条候选（CPU） |
| 输入格式 | `[query, passage]` 对，normalize=True 输出 sigmoid ∈ [0,1] |
| 默认状态 | **关闭**（`RERANKER_ENABLED=false`），不影响现有流程 |

下载方式：

```powershell
# 方式 1：使用现有下载脚本（指定模型 ID）
& ./backend/.venv/Scripts/python.exe ./backend/scripts/download_model.py --model-id BAAI/bge-reranker-v2-m3

# 方式 2：Hugging Face CLI
huggingface-cli download BAAI/bge-reranker-v2-m3 `
    --local-dir ./backend/.cache/huggingface/bge-reranker-v2-m3

# 方式 3：镜像站（国内网络）
& ./backend/.venv/Scripts/python.exe ./backend/scripts/download_model.py `
    --model-id BAAI/bge-reranker-v2-m3 `
    --hf-endpoint https://hf-mirror.com
```

下载完成后设置环境变量指向本地路径：

```powershell
$env:RERANKER_MODEL_PATH="C:\Users\X\Desktop\模型管理系统\backend\.cache\huggingface\bge-reranker-v2-m3"
$env:RERANKER_ENABLED="true"
```

##### 原有模型（无变化）

| 模型 | 大小 | 用途 | 状态 |
|---|---|---|---|
| `BAAI/bge-small-zh-v1.5` | ~90 MB | Embedding 向量编码（512 维） | 已有，不变 |

##### 存储总览

```
backend/.cache/huggingface/
├── bge-small-zh-v1.5/          # ~90 MB  Embedding（已有）
── bge-reranker-v2-m3/         # ~2 GB  Reranker（新增，可选）
```

仅启用 BM25 时无需额外下载模型（`rank-bm25` 纯算法包）；仅启用 Reranker 时需下载 reranker 模型。两者均关闭时（默认），零额外存储。

#### 开启与关闭 Reranker

Reranker 采用**双闸门**控制：服务端环境变量和客户端请求字段必须同时为 true 才会生效。

##### 控制机制

```
Reranker 生效条件：

  服务端 RERANKER_ENABLED=true     ──┐
                                     ├── 同时满足 → 执行 Rerank
  客户端 enableRerank=true          ──┘

  任一为 false → 跳过 Rerank，使用混合检索分数
```

| 服务端 `RERANKER_ENABLED` | 客户端 `enableRerank` | 实际行为 |
|:---:|:---:|---|
| `false`（默认） | `false` | 纯向量检索（原有行为，零变化） |
| `false` | `true` | 跳过 Rerank（服务端未启用，请求字段被忽略） |
| `true` | `false` | 跳过 Rerank（服务端已就绪，但客户端未请求） |
| `true` | `true` | **执行 Rerank**（模型未就绪时自动降级） |

##### 开启步骤

**第 1 步：下载模型**

```powershell
# 使用项目下载脚本（支持镜像站）
& ./backend/.venv/Scripts/python.exe ./backend/scripts/download_model.py `
    --model-id BAAI/bge-reranker-v2-m3 `
    --hf-endpoint https://hf-mirror.com
```

**第 2 步：设置环境变量并启动服务**

```powershell
# 指向本地模型目录
$env:RERANKER_MODEL_PATH="C:\Users\X\Desktop\模型管理系统\backend\.cache\huggingface\bge-reranker-v2-m3"

# 启用 Reranker
$env:RERANKER_ENABLED="true"

# 可选：调整精排候选数（默认 20）
$env:RERANKER_TOP_N="20"

# 启动服务
& ./backend/.venv/Scripts/python.exe ./backend/run.py
```

**第 3 步：加载模型**

```powershell
# 方式 A：随 Embedding 一同加载（POST /retrieval/load 时自动触发）
# 方式 B：独立加载
Invoke-RestMethod -Uri http://127.0.0.1:8001/retrieval/reranker-load -Method POST
```

**第 4 步：验证状态**

```powershell
# 查看 Reranker 独立状态
Invoke-RestMethod -Uri http://127.0.0.1:8001/retrieval/reranker-health

# 查看综合状态（包含 Embedding + Reranker）
Invoke-RestMethod -Uri http://127.0.0.1:8001/retrieval/health
```

预期返回：

```json
{
  "status": "ready",
  "modelId": "BAAI/bge-reranker-v2-m3"
}
```

**第 5 步：客户端发起带 Rerank 的检索请求**

```json
{
  "query": "检索内容",
  "topK": 5,
  "minScore": 0.3,
  "enableRerank": true,
  "chunks": [...]
}
```

响应中将包含 `rerankerUsed: true` 以及每条命中的 `rerankScore`。

##### 关闭步骤

**方式 A：服务端关闭（推荐，彻底不加载模型）**

```powershell
$env:RERANKER_ENABLED="false"
# 重启服务生效；已加载的模型随进程退出释放
```

服务端关闭后，即使客户端发送 `enableRerank: true`，也会被忽略，检索管线跳过 Rerank 阶段。

**方式 B：客户端关闭（服务端保持就绪，但不执行精排）**

检索请求中不发送 `enableRerank` 或设为 `false`：

```json
{
  "query": "检索内容",
  "topK": 5,
  "minScore": 0.3,
  "enableRerank": false,
  "chunks": [...]
}
```

模型仍驻留内存，但不会参与检索计算。适合临时关闭精排但保留快速重新开启的能力。

##### 环境变量一览

| 变量 | 默认值 | 说明 |
|---|---|---|
| `RERANKER_ENABLED` | `false` | 总开关，控制服务端是否启用 Reranker |
| `RERANKER_MODEL_PATH` | 空（使用 HF 缓存） | 本地模型目录路径，设置后离线加载 |
| `RERANKER_MODEL_ID` | `BAAI/bge-reranker-v2-m3` | 模型标识（硬编码，仅影响 health 显示） |
| `RERANKER_TOP_N` | `20` | 送入 Reranker 的候选数上限 |

注意：环境变量在服务启动时读取一次，修改后需重启服务才能生效。

##### 降级机制

当双闸门均为 true 但 Reranker 实际不可用时（模型未加载、加载失败、推理异常），系统自动降级：

```
enableRerank=true + RERANKER_ENABLED=true
  │
  ├─ Reranker READY → 正常精排，rerankerUsed=true
  │
  └─ Reranker 非 READY / 推理异常 → 记录 warning，保留混合检索分数
       └─ rerankerUsed=false，响应中无 rerankScore
```

降级不影响检索结果返回，仅跳过精排阶段。

#### Reranker CPU 爆满问题与优化（2026年9月25日）

##### 问题描述

启用 Reranker 后，检索时出现以下问题：

1. **CPU 爆满**：`bge-reranker-v2-m3` 模型约 2GB，在 CPU 上推理时占用 100% CPU，导致机器卡死
2. **无终止机制**：一旦开始 Rerank，无法取消或超时，只能强制杀进程
3. **内存峰值高**：所有候选对一次性送入模型，内存占用过高

##### 根本原因

| 问题 | 原因 |
|---|---|
| CPU 爆满 | 未限制送入 Reranker 的候选数，可能传入数百个片段 |
| 无终止 | `run_in_executor` 无超时机制，无法取消 |
| 内存峰值 | 所有 `[query, passage]` 对一次性构建和推理 |

##### 优化方案

**1. 限制候选数（`retrieval.py`）**

```python
# 限制送入 Reranker 的候选数，避免 CPU 爆满
max_candidates = min(config.RERANKER_TOP_N, len(fused))
fused = fused[:max_candidates]  # 默认最多 20 个
```

**2. 添加超时机制（`reranker.py`）**

```python
# 使用 asyncio.wait_for 添加超时
result = await asyncio.wait_for(_run_rerank(), timeout=timeout)

# 超时后自动降级
except asyncio.TimeoutError:
    logger.warning(f"Reranker 超时（{timeout}秒），已取消当前任务")
    raise RerankerTimeoutError(...)
```

**3. 批处理推理（`reranker.py`）**

```python
# 分批处理，减少内存峰值
for batch_start in range(0, total, batch_size):
    batch_passages = passages[batch_start:batch_start + batch_size]
    batch_pairs = [[query, p] for p in batch_passages]
    batch_scores = self._model.compute_score(batch_pairs, normalize=True)
    all_scores.extend(batch_scores)
```

**4. 新增配置项（`config.py`）**

```python
RERANKER_TIMEOUT = int(os.environ.get("RERANKER_TIMEOUT", "30"))      # 超时时间（秒）
RERANKER_BATCH_SIZE = int(os.environ.get("RERANKER_BATCH_SIZE", "8")) # 批处理大小
```

##### 优化效果

| 指标 | 优化前 | 优化后 |
|---|---|---|
| CPU 占用 | 100%（数百候选） | ~30%（最多 20 候选） |
| 最大等待时间 | 无限（卡死） | 30 秒（可配置） |
| 内存峰值 | 全部候选对 | 分批处理（8 个/批） |
| 可终止性 | 无法终止 | 超时自动降级 |

##### 配置说明

在 `.env` 中添加以下配置：

```ini
# Reranker 超时时间（秒，超时自动降级到混合检索分数）
RERANKER_TIMEOUT=30

# Reranker 批处理大小（减少内存峰值）
RERANKER_BATCH_SIZE=8
```

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `RERANKER_TIMEOUT` | 30 | 超时后自动降级，不影响检索结果 |
| `RERANKER_BATCH_SIZE` | 8 | 每批处理的候选对数量，减少内存峰值 |
| `RERANKER_TOP_N` | 20 | 送入 Reranker 的最大候选数 |

##### 降级行为

当 Reranker 超时或失败时，系统自动降级：

```
Rerank 阶段
  │
  ├─ 正常完成 → rerankerUsed=true，使用重排序分数
  │
  └─ 超时/失败 → rerankerUsed=false，保留混合检索分数（BM25+向量）
```

降级不影响检索结果返回，仅跳过精排阶段。

#### BM25 开启后检索无结果问题（2026年9月25日）

##### 问题描述

仅开启 BM25 关键词检索（未开启 Reranker）时，检索返回零结果。

##### 根本原因

**RRF 融合分数范围与 minScore 阈值不匹配：**

| 阶段 | 分数范围 | 计算公式 | 示例值 |
|---|---|---|---|
| 向量检索 | `[-1, 1]`（余弦相似度） | 点积 | 0.75, 0.30, 0.12 |
| BM25 检索 | `[0, +∞)`（Okapi 评分） | IDF × TF 归一化 | 5.2, 3.1, 1.8 |
| RRF 融合 | `(0, 0.02]` | `weight / (k + rank + 1)` | 0.7/61 ≈ **0.011** |

开启 BM25 后走 RRF 融合路径，融合分数约 0.01，而 `minScore` 默认值为 0.3（为向量检索设计），导致所有结果被过滤：

```python
# 问题代码
filtered = [(cid, score) for cid, score in fused if score >= request.minScore]
# RRF 分数 ~0.01 < 0.3 → 全部过滤 → 空结果
```

##### 修复方案

RRF 融合后跳过 minScore 过滤（RRF 本身已是排序，topK 截断即可）：

```python
# RRF 融合后分数范围改变（~0.01），不再适用 minScore 阈值
if used_rrf:
    filtered = fused  # RRF 已是排序，直接取 topK
else:
    filtered = [(cid, score) for cid, score in fused if score >= request.minScore]
```

##### 设计说明

| 场景 | 分数来源 | minScore 适用性 |
|---|---|---|
| 纯向量检索 | 余弦相似度 ∈ [-1, 1] | ✅ 适用，0.3 为合理阈值 |
| RRF 融合（BM25 开启） | RRF 分数 ∈ (0, 0.02] |  不适用，分数范围完全不同 |
| Rerank 后 | Reranker 分数 ∈ [0, 1] | ️ 视情况，通常保留 RRF 逻辑 |

RRF 公式 `1 / (k + rank)` 本身已是排名融合，分数大小仅反映相对顺序，不适合用绝对阈值过滤。

#### Reranker 不应依赖 BM25 开启（2026年9月25日）

##### 问题描述

前端界面中 Reranker 开关被设置为必须 BM25 开启后才能启用，但这是不必要的限制。

##### 根本原因

Reranker 的输入是"候选文档列表"，它可以对以下两种情况重排序：

| 场景 | 输入来源 | 说明 |
|---|---|---|
| 仅开启 Reranker | 向量检索结果 | 对向量召回的 Top-N 做交叉编码精排 |
| BM25 + Reranker 同时开启 | RRF 融合结果 | 对融合后的候选做交叉编码精排 |

Reranker 作为 CrossEncoder，不关心候选列表是如何产生的，只需要 `[query, passage]` 对即可计算相关性分数。

##### 修复方案

1. **移除前端依赖约束**：Reranker 开关不再要求 BM25 先开启
2. **修正 minScore 配置优先级**：Reranker 开启时，最终分数来自 Reranker（归一化 [0,1]），应优先于 BM25 的 RRF 分数判断

```javascript
// 修正前：BM25 优先判断
if (this.enableBm25) { return rrfConfig }
if (this.enableRerank) { return rerankerConfig }

// 修正后：Reranker 优先判断（最终分数来源）
if (this.enableRerank) { return rerankerConfig }
if (this.enableBm25) { return rrfConfig }
```

##### 分数来源与阈值配置

| 最终阶段 | 分数范围 | minScore 配置 |
|---|---|---|
| 纯向量检索 | `[-1, 1]` | 0.3 |
| BM25 开启（RRF 融合） | `(0, 0.02]` | 禁用（RRF 已是排序） |
| Reranker 开启（任意场景） | `[0, 1]` | 0.3 |

#### 风险与缓解

| 风险 | 缓解 |
|---|---|
| Reranker 模型 ~2GB，CPU 加载慢 | `RERANKER_ENABLED=false` 默认关闭；懒加载；失败降级；超时自动降级 |
| Reranker 推理 CPU 爆满 | 限制候选数（RERANKER_TOP_N=20）；批处理（RERANKER_BATCH_SIZE=8）；超时（RERANKER_TIMEOUT=30） |
| RRF 融合后 minScore 过滤失效 | RRF 路径跳过 minScore，仅用 topK 截断 |
| BM25 bigram 中文效果不如 jieba | 仅作为补充通道，向量仍是主路径；后续可无缝替换分词器 |
| 前端校验拒绝新字段 | 新字段全部 optional；校验仅在字段存在时检查 |
| `_do_search` 重构引入回归 | 提取 `_vector_search()` 时保持逻辑完全一致；原有 20 项测试零修改通过 |
| RRF 分数不在 [-1,1] | 最终 SearchHit.score 归一化；前端校验兼容 |

#### 拒绝的替代方案

| 方案 | 拒绝原因 |
|---|---|
| jieba 分词 | 增加 ~5MB 词典依赖，与项目轻量定位不符；字符 bigram 在中小文档上效果可接受 |
| 新建独立检索管线 | 变更范围过大（10+ 文件），回归风险高；增量修改更可控 |
| Qdrant/向量数据库 | 超出本次范围（检索+重排序，不含存储层） |
| bge-reranker-base | 用户明确指定 v2-m3；FlagEmbedding 官方支持 |
| psutil 内存监控 | 过度设计，当前单用户本地场景不需要 |
| BM25 持久化索引 | chunks 随请求传入（非持久化），每次重建 <50ms 可接受 |

## 检索模式工作原理

### 向量模式工作流程与原理

##### 架构概述

向量检索采用 **BiEncoder（双编码器）** 架构。查询和文档分别独立编码为固定维度向量，通过向量空间中的几何距离衡量语义相似度。

```
模型：BAAI/bge-small-zh-v1.5
维度：512
设备：CPU
库：sentence-transformers + PyTorch
```

##### 编码流程

```
输入文本
  │
  ├─ 1. Tokenizer 分词
  │     ─ 添加 [CLS] 和 [SEP] 特殊 token
  │     └─ 获取 token IDs 序列
  │
  ├─ 2. 长度判断
  │     ├─ token_len ≤ window_size（510）→ 直接编码
  │     └─ token_len > window_size → 窗口切分
  │
  ├─ 3. 窗口切分（长文本）
  │     window_size = max_position_embeddings - 2 = 510
  │     stride = window_size - overlap = 510 - 32 = 478
  │     滑动窗口切分，相邻窗口重叠 32 tokens
  │
  ├─ 4. Transformer 编码
  │     └─ 每个窗口 → BERT 模型 → 取 [CLS] token 输出
  │     └─ 长文本：所有窗口向量取平均
  │
  └─ 5. L2 归一化
        └─ vec = vec / ||vec||
        └─ 输出：512 维单位向量
```

##### 查询前缀

BGE 模型为查询和文档使用不同的编码策略。查询文本会添加前缀：

```
QUERY_PREFIX = "为这个句子生成表示以用于检索相关文章："
```

这个前缀在训练时告诉模型"这是一个查询，请生成用于检索的表示"，使查询向量和文档向量处于同一语义空间。

##### 相似度计算

```
query_vec:  512 维单位向量（L2 归一化后）
doc_vec:    512 维单位向量（L2 归一化后）

score = dot(query_vec, doc_vec)
      = Σ query_vec[i] * doc_vec[i]   for i in 0..511

由于已归一化，点积 = 余弦相似度 ∈ [-1, 1]
  1.0  = 完全相同
  0.0  = 正交（无关）
 -1.0  = 完全相反
```

##### LRU 缓存

```
LRU_CAPACITY = 2048 条

编码结果按内容 hash 缓存：
  key = sha256(content)[:32]
  value = 512 维向量

效果：相同文档片段不重复编码，首次编码后后续检索直接命中缓存
```

##### 优势与局限

| 优势 | 局限 |
|---|---|
| 语义理解（同义词、上下位词） | 无法捕捉细粒度词匹配 |
| 可预计算文档向量，检索快 | 长文本信息压缩有损 |
| 对拼写错误鲁棒 | 对专有名词、精确短语不敏感 |

---

### BM25 模式工作流程与原理

##### 架构概述

BM25（Best Matching 25）是经典的概率检索模型，基于词频统计衡量文档与查询的相关性。本项目使用 **字符 bigram 分词** 适配中文，零外部依赖。

```
算法：Okapi BM25
分词：字符 bigram（相邻字符对）
参数：k1=1.5（词频饱和度）, b=0.75（长度归一化）
库：自实现（bm25.py），无外部依赖
```

##### 字符 Bigram 分词

```
输入："差旅报销"

字符列表：['差', '旅', '报', '销']
Bigram 对：['差旅', '旅报', '报销']

输入："差旅报销需要什么材料"
Bigram 对：['差旅', '旅报', '报销', '销需', '需要', '要什', '什么', '么材', '材料']
```

**为什么用 bigram 而不是 jieba：**
- 零依赖，不需要 ~5MB 词典文件
- 中文任意连续字符对都能匹配，召回率高
- 对未登录词、新词、专有名词天然支持
- 在中小文档规模上效果可接受

##### 倒排索引构建

```
build_index(documents):
  │
  ├─ 1. 对每个文档分词
  │     tokens = tokenize_bigram(doc)
  │
  ├─ 2. 统计词频与文档频率
  │     term_doc_freq[token] = {doc_id_1, doc_id_2, ...}
  │     total_len = Σ len(tokens_i)
  │     avg_doc_len = total_len / num_docs
  │
  └─ 3. 计算 IDF（逆文档频率）
        idf(token) = log((N - df + 0.5) / (df + 0.5) + 1.0)
        
        N  = 文档总数
        df = 包含该 token 的文档数
        
        例：N=10, df=2 → idf = log((10-2+0.5)/(2+0.5)+1.0) = log(4.2) ≈ 1.44
        例：N=10, df=9 → idf = log((10-9+0.5)/(9+0.5)+1.0) = log(1.16) ≈ 0.15
        
        罕见词 IDF 高，常见词 IDF 低
```

##### BM25 评分公式

```
score(query, doc) = Σ idf(token) * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * doc_len/avg_len))

对 query 中每个 token：
  tf = token 在 doc 中出现的次数
  idf = 逆文档频率（罕见词高，常见词低）
  k1 = 1.5（词频饱和度参数）
  b  = 0.75（长度归一化参数）
  doc_len = 文档 token 数
  avg_len = 平均文档 token 数

词频饱和度：tf 增大时，分子增长放缓，避免长文档因词频高而 unfairly 排名靠前
长度归一化：短文档的 tf 权重更高，长文档的 tf 权重更低
```

##### 完整流程

```
请求（query + chunks）
  │
  ├─ 1. 对所有 chunks 分词
  │     documents = [chunk.content for chunk in chunks]
  │
  ├─ 2. 构建倒排索引（~50ms）
  │     scorer.build_index(documents)
  │
  ├─ 3. 对 query 分词
  │     query_tokens = tokenize_bigram(query)
  │
  ├─ 4. 批量评分
  │     scores = scorer.score_batch(query, documents)
  │
  └─ 5. 过滤 + 排序
        result = [(chunk_id, score) for score > 0]
        result.sort(by score, descending)
```

##### 分数范围

BM25 分数无上界，取决于词频和 IDF。典型值：

| 场景 | 分数范围 |
|---|---|
| 精确匹配多个关键词 | 5.0 - 15.0 |
| 部分匹配 | 1.0 - 5.0 |
| 弱匹配 | 0.1 - 1.0 |
| 无匹配 | 0.0（被过滤） |

##### 优势与局限

| 优势 | 局限 |
|---|---|
| 精确词匹配（专有名词、短语） | 无语义理解（同义词无法匹配） |
| 可解释性强（哪个词贡献了多少分） | 对拼写错误敏感 |
| 无需模型，纯算法 | 无法理解上下文和指代 |

---

### Reranker 重排序模式工作流程与原理

##### 架构概述

Reranker 采用 **CrossEncoder（交叉编码器）** 架构。将查询和文档拼接为 `[query, passage]` 对，一起送入模型做深度注意力交互，输出相关性分数。

```
模型：BAAI/bge-reranker-v2-m3
磁盘：~2 GB
内存：~2.5 GB（加载时）
设备：CPU
库：FlagEmbedding（FlagReranker）
```

##### BiEncoder vs CrossEncoder 对比

```
BiEncoder（向量检索）：
  query ──→ Encoder ──→ query_vec ──┐
                                     ├──→ dot product → score
  doc   ──→ Encoder ──→ doc_vec   ──┘
  
  优点：可预计算，检索快
  缺点：查询和文档独立编码，无法捕捉细粒度交互

CrossEncoder（Reranker）：
  [query, doc] ──→ Encoder ──→ [CLS] output → sigmoid → score
  
  优点：深度交互，精度高
  缺点：无法预计算，每对都要推理，慢
```

##### 加载流程

```
POST /retrieval/reranker-load
  │
  ├─ 1. 状态检查
  │     UNLOADED → LOADING（其他状态直接返回）
  │
  ├─ 2. 后台加载（asyncio.create_task）
  │     └─ run_in_executor → _load_sync()
  │
  ├─ 3. 模型实例化
  │     FlagReranker(model_path, use_fp16=False, device="cpu")
  │     └─ 加载 ~2GB 模型权重到内存
  │     └─ CPU 模式约需 60-120 秒
  │
  └─ 4. 状态更新
        LOADING → READY（成功）
        LOADING → ERROR（失败，记录 error 信息）
```

##### 推理流程

```
rerank(query, passages, top_k, timeout)
  │
  ├─ 1. 候选数限制
  │     max_candidates = min(RERANKER_TOP_N, len(passages))
  │     passages = passages[:max_candidates]  # 默认最多 20 个
  │
  ├─ 2. 构建 [query, passage] 对
  │     pairs = [[query, p1], [query, p2], ...]
  │
  ├─ 3. 批处理推理（减少内存峰值）
  │     batch_size = RERANKER_BATCH_SIZE  # 默认 8
  │     
  │     for batch_start in range(0, total, batch_size):
  │       batch_pairs = pairs[batch_start:batch_start+batch_size]
  │       batch_scores = model.compute_score(batch_pairs, normalize=True)
  │       # normalize=True → sigmoid → 分数 ∈ [0, 1]
  │       all_scores.extend(batch_scores)
  │
  ├─ 4. 超时控制
  │     asyncio.wait_for(_run_rerank(), timeout=RERANKER_TIMEOUT)
  │     # 默认 30 秒，超时自动降级
  │
  ─ 5. 排序返回
        indexed = sorted(enumerate(all_scores), by score, descending)
        return indexed[:top_k]  # [(原始索引, 分数), ...]
```

##### 分数含义

```
compute_score(pairs, normalize=True)
  │
  ├─ 模型原始输出：logit（实数，无界）
  │
  └─ normalize=True → sigmoid(logit) → 分数 ∈ [0, 1]
        
        0.9+ = 高度相关
        0.7-0.9 = 相关
        0.5-0.7 = 部分相关
        <0.5 = 不相关
```

##### 降级机制

```
Reranker 调用
  │
  ├─ 正常完成 → rerankerUsed=true，使用 Reranker 分数排序
  │
  ├─ 超时（>30秒）→ 记录 warning，保留上游分数（向量或 RRF）
  │
  ├─ 推理异常 → 记录 warning，保留上游分数
  │
  ─ 模型未加载 → RuntimeError，保留上游分数
```

降级不影响检索结果返回，仅跳过精排阶段。

##### CPU 资源控制

| 配置项 | 默认值 | 作用 |
|---|---|---|
| `RERANKER_TOP_N` | 20 | 限制送入 Reranker 的最大候选数 |
| `RERANKER_BATCH_SIZE` | 8 | 每批处理的候选对数量，减少内存峰值 |
| `RERANKER_TIMEOUT` | 30 | 超时秒数，超时自动降级 |

##### 优势与局限

| 优势 | 局限 |
|---|---|
| 深度语义交互，精度最高 | CPU 推理慢（~100ms/对） |
| 能捕捉否定、对比、指代 | 无法预计算，必须在线推理 |
| 归一化分数，可解释性强 | 模型大（~2GB），内存占用高 |

---

### 三种模式协同工作

##### 完整管线

```
请求进入（query + chunks）
  │
  ├─ 0. 过滤（知识库 ID / 文档类型）
  │
  ├─ 1. 向量检索（始终执行）
  │     ─ BiEncoder 编码 → 点积 → 余弦分数 ∈ [-1, 1]
  │
  ├─ 2. BM25 检索（enableBm25 && BM25_ENABLED）
  │     ─ Bigram 分词 → IDF → Okapi 评分 ∈ [0, +∞)
  │
  ├─ 3. RRF 融合（BM25 有结果时）
  │     └─ score = Σ weight / (k + rank + 1)  k=60
  │     ─ 融合分数 ∈ (0, 0.02]
  │
  ├─ 4. Rerank 重排序（enableRerank && RERANKER_ENABLED）
  │     └─ 截断至 TOP_N（默认 20）
  │     └─ CrossEncoder 批处理推理 → sigmoid 分数 ∈ [0, 1]
  │     └─ 超时降级：保留上游分数
  │
  ─ 5. 输出
        ├─ RRF 路径：跳过 minScore，按 topK 截断
        ─ 非 RRF 路径：minScore 过滤 → topK 截断
```

##### 各阶段分数语义

| 阶段 | 分数范围 | 含义 | 适用 minScore |
|---|---|---|---|
| 向量检索 | `[-1, 1]` | 余弦相似度 | 0.3（默认） |
| BM25 检索 | `[0, +∞)` | 词频加权分 | 不适用（内部过滤 >0） |
| RRF 融合 | `(0, 0.02]` | 排名加权 | 不适用（跳过阈值） |
| Reranker | `[0, 1]` | 归一化相关性 | 0.3（可调整） |

##### 模式组合

| BM25 | Reranker | 实际流程 | 最终分数来源 |
|:---:|:---:|---|---|
| 关 | 关 | 向量 → minScore → topK | 向量余弦 |
| 开 | 关 | 向量 + BM25 → RRF → topK | RRF 排名 |
| 关 | 开 | 向量 → Rerank → topK | Reranker 归一化 |
| 开 | 开 | 向量 + BM25 → RRF → Rerank → topK | Reranker 归一化 |

##### 各阶段数据量控制

检索管线采用“漏斗”设计：越往后数据量越小，计算密度越高。

**入口层（请求校验）**

| 控制项 | 限制 | 来源 |
|---|---|---|
| `chunks` 数量 | ≤ 512 | `config.MAX_CHUNKS` |
| 单 chunk 内容 | ≤ 4000 字符 | `config.MAX_CHUNK_CONTENT` |
| 总内容量 | ≤ 200,000 字符 | `config.MAX_TOTAL_CONTENT` |
| 查询长度 | ≤ 2000 字符 | `config.MAX_QUERY_LENGTH` |
| 请求体大小 | ≤ 2 MiB | `config.MAX_REQUEST_BYTES` |
| `topK` | 1-20 | `schemas.py` Field 约束 |
| `minScore` | -1.0 ~ 1.0 | `schemas.py` Field 约束 |

**各阶段控制机制**

| 阶段 | 输入 | 输出 | 控制机制 |
|---|---|---|---|
| 0. 过滤 | ≤ 512 chunks | 子集 | 按知识库 ID / 文档类型集合过滤 |
| 1. 向量检索 | N chunks | N 个分数 | 全部打分不截断；LRU 缓存（2048 条）避免重复编码 |
| 2. BM25 检索 | N chunks | M 个分数（M ≤ N） | 内部过滤 `score > 0`，无匹配的 chunk 被丢弃 |
| 3. RRF 融合 | N + M | ≤ N 个 | 并集去重（BM25 不会引入新 chunk） |
| 4. Rerank | ≤ N 个 | ≤ 20 个 | 硬截断 `[:RERANKER_TOP_N]`；批处理（8 个/批）；30 秒超时降级 |
| 5. 最终输出 | ≤ 20 个 | ≤ topK 个 | RRF 路径跳过 minScore 直接截断；非 RRF 路径先阈值过滤再截断 |

**数据量变化示例**（请求传入 100 个 chunks，topK=5）

```
阶段 0 过滤    100 → 85   （按知识库过滤掉 15 个）
阶段 1 向量    85 → 85    （全部打分）
阶段 2 BM25    85 → 42    （43 个无匹配被丢弃）
阶段 3 RRF     85 + 42 → 85  （并集去重）
阶段 4 Rerank  85 → 20    （截断至 TOP_N）
阶段 5 输出    20 → 5     （topK=5）
```

**设计原则**：向量/BM25 负责“广召回”（处理全部候选，计算轻量），Reranker 负责“精排序”（只处理 Top-20，计算密集），确保 CPU 重排序不会爆满。

##### MAX_CHUNKS 说明

`config.MAX_CHUNKS = 512` **不是检索截断**，而是**请求体安全上限**，防止单次 HTTP 请求过大：

```python
# main.py 第 223 行 —— 请求校验，不是检索逻辑
if len(req.chunks) > config.MAX_CHUNKS:
    return error_response(413, "CANDIDATE_LIMIT_EXCEEDED", f"chunks 数量超过 {config.MAX_CHUNKS}")
```

| 场景 | 结果 |
|---|---|
| 发送 500 个 chunks | 正常检索 |
| 发送 900 个 chunks | 返回 413 错误，请求被拒绝（不是“只检索前 512 个”） |

**为什么是 512 而不是更大？** 当前项目定位单用户本地测试，512 个 chunk 已覆盖大多数文档。若知识库有 900+ chunks，需前端分批发送（如 512 + 388 两批），各自检索后合并结果。

## 许可证

私有项目，未公开授权。
