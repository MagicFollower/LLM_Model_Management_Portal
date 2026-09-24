# Embedding 模型工作原理与检索闭环归档

> 本文档归档 HuggingFace BGE 中文 Embedding 模型的集成实施，介绍 Embedding 模型工作原理，并结合本项目展示完整检索闭环。

## 1. 本次改动归档

### 1.1 新增文件

| 文件 | 职责 |
|---|---|
| `backend/app/config.py` | 检索服务配置（模型 ID、维度、查询前缀、资源上限） |
| `backend/app/schemas.py` | Pydantic v2 DTO（请求/响应模型与字段校验） |
| `backend/app/embedding.py` | 模型生命周期管理：lazy load、token 窗口切分、CLS 池化、L2 归一化 |
| `backend/app/retrieval.py` | LRU 向量缓存（2048 条）、余弦相似度聚合、单任务并发控制 |
| `backend/app/main.py` | FastAPI 路由（health/load/search）、Host/Origin 回环校验 |
| `backend/run.py` | 服务启动入口（`127.0.0.1:8001`） |
| `backend/tests/test_retrieval.py` | 20 项 pytest 单测（fake encoder，不联网） |
| `backend/requirements.txt` | 运行依赖 |
| `backend/requirements-dev.txt` | 测试依赖 |
| `backend/.env.example` | 模型来源配置说明 |
| `frontend/src/types/retrieval.ts` | 独立检索类型定义（不污染主类型集合） |
| `frontend/src/api/retrieval.ts` | 同源 HTTP 传输层（取消/超时/错误处理、响应校验） |
| `frontend/src/api/retrieval.test.ts` | 48 项检索 API 单测 |
| `frontend/src/mock/retrieval.ts` | 共享检索模块（候选快照、二次校验、依赖注入） |
| `frontend/src/mock/retrieval.test.ts` | 54 项检索模块单测 |
| `frontend/src/components/KnowledgeRetrievalPanel.vue` | 知识库详情页检索测试区组件 |

### 1.2 修改文件

| 文件 | 改动 |
|---|---|
| `frontend/src/mock/index.ts` | read 回调增加 users/models 快照数据；generate/stream 接入共享检索 |
| `frontend/src/mock/index.test.ts` | 49 项旧 Mock 测试显式选择 demo 模式 |
| `frontend/src/views/KnowledgeDetailView.vue` | 挂载 KnowledgeRetrievalPanel 组件 |
| `frontend/src/views/ChatView.vue` | 对话引用接入实际检索结果，标注"本地 BGE 实际检索" |
| `frontend/src/views/KnowledgeView.vue` | 更新能力描述 |
| `frontend/src/views/LoginView.vue` | 更新能力描述 |
| `frontend/vite.config.ts` | 添加 `/retrieval` 代理到 `127.0.0.1:8001` |
| `.gitignore` | 添加 Python 虚拟环境、模型缓存排除 |
| `README.md` | 补充后端目录、检索能力、启动流程、测试数量 |
| `HuggingFace小型Embedding与知识库检索实施方案.md` | 执行记录与实测数据 |

### 1.3 测试统计

| 维度 | 数量 | 状态 |
|---|---|---|
| 前端 Vitest | 248 项 | ✅ 全部通过 |
| 后端 pytest | 20 项 | ✅ 全部通过 |
| vue-tsc 类型检查 | — | ✅ 通过 |
| vite build | — | ✅ 通过 |

### 1.4 实测数据

- **模型**: BAAI/bge-small-zh-v1.5（revision `7999e1d3`，Apache-2.0）
- **维度**: 512，max_seq_length: 512
- **查询**: "差旅报销需要什么材料？"
- **结果**: c2（差旅相关）score=0.7507 Top1，c1（会议室）score=0.3007，c3（数据库）被 minScore=0.3 过滤
- **耗时**: ≈56ms（3 个候选片段，CPU 推理）

### 1.5 浏览器端到端验证

| 步骤 | 状态 | 证据 |
|---|---|---|
| 模型健康检测 | ✅ | "模型就绪" — BAAI/bge-small-zh-v1.5, 512维, CPU |
| 基础检索 | ✅ | 查询"差旅报销需要什么材料" → 命中1条 score=0.7203 |
| 上传+检索 | ✅ | 上传 TXT 后查询"出差报销审批" → 命中2条（0.6931, 0.6590） |
| 模拟对话引用 | ✅ | 回复包含3条引用卡片，标注"本地BGE实际检索" |

---

## 2. Embedding 模型工作原理

### 2.1 什么是 Embedding

Embedding（嵌入）是将离散符号（文字、词、句子）映射为连续向量空间中的稠密向量的过程。每个向量是一个固定维度的浮点数数组，语义相近的内容在向量空间中距离更近。

```
"差旅报销" → [0.12, -0.34, 0.56, ..., 0.78]  ← 512 维向量
"出差费用" → [0.11, -0.33, 0.55, ..., 0.77]  ← 语义相近，向量接近
"数据库备份" → [-0.45, 0.67, -0.12, ..., 0.03] ← 语义无关，向量远离
```

### 2.2 BGE 模型架构

本项目使用 `BAAI/bge-small-zh-v1.5`（北京智源人工智能研究院），架构如下：

```
输入文本
  │
  ▼
─────────────────────────┐
│  Tokenizer（分词器）      │  将文本切分为 token ID 序列
│  "为这个句子生成表示..."   │  查询添加前缀，文档不添加
└────────────┬────────────┘
             │
             ▼
┌─────────────────────────
│  BERT Encoder（12层）     │  双向 Transformer 编码器
│  自注意力 + 前馈网络       │  捕获上下文语义关系
└────────────┬────────────┘
             │
             ▼
┌─────────────────────────┐
│  CLS Pooling（池化）      │  取 [CLS] token 的输出向量
│  作为整句表示              │  512 维原始向量
└────────────┬────────────┘
             │
             ▼
┌─────────────────────────┐
│  L2 归一化               │  向量长度归一为 1
│  ‖v‖ = 1                │  点积 = 余弦相似度
└────────────┬────────────
             │
             ▼
        512 维单位向量
```

### 2.3 查询前缀机制

BGE 模型采用**非对称检索**设计：查询和文档使用不同的输入格式。

- **查询输入**: `为这个句子生成表示以用于检索相关文章：` + 用户问题
- **文档输入**: 原始文档片段（不加前缀）

这个前缀在模型预训练时学习，引导编码器为查询生成更适合检索的表示。不加前缀的查询向量与文档向量的相似度会显著降低。

### 2.4 相似度计算

经过 L2 归一化后，两个向量的**点积**等于它们的**余弦相似度**：

$$\text{similarity}(q, d) = \frac{q \cdot d}{\|q\| \times \|d\|} = q \cdot d \quad (\text{当 } \|q\| = \|d\| = 1)$$

- 相似度范围：[-1, 1]
- 1.0 = 完全相同方向（语义完全一致）
- 0.0 = 正交（语义无关）
- -1.0 = 完全相反方向

本项目默认阈值 minScore=0.3，过滤掉语义不相关的候选。

### 2.5 长文本窗口切分

模型最大输入长度为 512 tokens（约 300-400 个中文字符）。超过此长度的文本需要切分：

```
长文档: [token_1, token_2, ..., token_600]
         ├──── 窗口1 (510 tokens) ────┤
                    ├──── 窗口2 (510 tokens, overlap=32) ───┤
                                         ├──── 窗口3 ────┤

每个窗口独立编码 → 取所有窗口向量的平均 → L2 归一化
```

窗口重叠 32 tokens 确保边界内容不被截断丢失。

---

## 3. 项目整体架构与工作流程

### 3.1 系统架构总览

```mermaid
flowchart TB
    subgraph 前端["前端 Vue 3 (localhost:5174)"]
        UI[用户界面]
        Panel[KnowledgeRetrievalPanel<br/>检索测试区]
        Chat[ChatView<br/>模拟对话]
        Mock[mock/retrieval.ts<br/>候选快照与校验]
        Api[api/retrieval.ts<br/>HTTP 传输层]
    end

    subgraph 代理["Vite 开发代理"]
        Proxy["/retrieval → 127.0.0.1:8001"]
    end

    subgraph 后端["后端 Python FastAPI (127.0.0.1:8001)"]
        Router[路由层<br/>health/load/search]
        Validate[参数校验<br/>Host/Origin 回环检查]
        Retriever[RetrievalService<br/>LRU 缓存 + 并发控制]
        Encoder[EmbeddingService<br/>模型加载 + 编码]
        Model[(BGE 模型<br/>512 维 CPU)]
        Cache[(LRU 缓存<br/>2048 条)]
    end

    UI --> Panel
    UI --> Chat
    Panel --> Mock
    Chat --> Mock
    Mock --> Api
    Api --> Proxy
    Proxy --> Router
    Router --> Validate
    Validate --> Retriever
    Retriever --> Encoder
    Encoder --> Model
    Retriever --> Cache
```

### 3.2 完整检索闭环流程

```mermaid
sequenceDiagram
    participant User as 用户
    participant Panel as 检索测试区
    participant Mock as Mock 检索模块
    participant Api as 检索 HTTP 客户端
    participant Proxy as Vite 代理
    participant Server as FastAPI 服务
    participant Model as BGE 模型

    User->>Panel: 输入查询 "差旅报销需要什么材料"
    Panel->>Mock: searchKnowledgeBases(kbIds, query, options)

    Note over Mock: 1. 授权检查与候选快照
    Mock->>Mock: 读取当前用户有权访问的 KB
    Mock->>Mock: 过滤 ready 状态 TXT/MD 文档
    Mock->>Mock: 排除 PDF/DOCX/预览/空正文
    Mock->>Mock: 冻结文档 ID/版本/状态/片段快照

    Note over Mock: 2. 判断检索模式
    alt local 模式
        Mock->>Api: searchVectors(query, topK, minScore, chunks)
        Api->>Proxy: POST /retrieval/search
        Proxy->>Server: 转发请求

        Note over Server: 3. 服务端处理
        Server->>Server: 参数校验（长度/数量/大小）
        Server->>Server: 并发检查（繁忙返回 429）

        Server->>Model: 编码查询（加前缀）
        Model-->>Server: 查询向量 q (512维)

        loop 每个候选片段
            Server->>Server: 检查 LRU 缓存
            alt 缓存命中
                Server->>Server: 取缓存向量
            else 缓存未命中
                Server->>Model: 编码片段
                Model-->>Server: 片段向量 d (512维)
                Server->>Server: 写入 LRU 缓存
            end
            Server->>Server: 计算 q·d（余弦相似度）
        end

        Server->>Server: 过滤 minScore，降序排序，取 topK
        Server-->>Proxy: {hits, modelId, elapsedMs}
        Proxy-->>Api: JSON 响应
        Api->>Api: 校验响应结构

        Note over Mock: 4. 二次校验
        Mock->>Mock: 重新读取数据库
        Mock->>Mock: 验证身份/权限/版本/状态未变
        Mock->>Mock: 验证返回 ID 属于原快照
        Mock-->>Panel: KnowledgeSearchResult

        Panel->>User: 显示命中卡片（分数+文档名+原文）
    else demo 模式
        Mock->>Mock: 返回固定引用（不调用服务）
        Mock-->>Panel: 标注"离线演示"的引用
    end
```

### 3.3 模型加载与状态机

```mermaid
stateDiagram-v2
    [*] --> unloaded: 服务启动

    unloaded --> loading: POST /retrieval/load
    loading --> ready: 下载+加载+维度验证+测试编码通过
    loading --> error: 下载失败/维度不匹配/非有限值/零向量

    error --> loading: 用户点击重试

    ready --> searching: POST /retrieval/search
    searching --> ready: 返回结果（含无命中）
    searching --> ready: 用户取消/超时

    note right of ready
        模型 BAAI/bge-small-zh-v1.5
        512 维 · CPU · L2 归一化
        查询前缀: 为这个句子生成表示...
    end note

    note right of loading
        单任务并发
        后台线程下载
        health 不阻塞
    end note
```

### 3.4 模拟对话引用流程

```mermaid
sequenceDiagram
    participant UI as 对话页面
    participant Mock as Mock 业务层
    participant R as 共享检索模块
    participant S as 本地检索服务

    UI->>Mock: 用户发送问题 + 选择知识库
    Mock->>Mock: 幂等检查、消息登记、返回 generationId
    UI->>Mock: stream 订阅

    Mock->>Mock: 锁定任务，开始流式输出

    Note over Mock,R: 异步检索（不阻塞首 token）
    Mock->>R: 问题 + 已选知识库 IDs
    R->>R: 授权检查 + 候选快照
    R->>S: POST /retrieval/search
    S-->>R: 命中 ID + 真实分数
    R->>R: 二次校验（身份/权限/版本）
    R-->>Mock: 引用快照

    Mock->>Mock: 将检索结果注入模板
    Mock-->>UI: 模板 delta + citations + done

    Note over UI: 引用卡片显示文档名、片段版本、原文
    Note over UI: 标注"实际Embedding检索，回答仍为模板"
```

### 3.5 数据流与责任边界

```mermaid
flowchart LR
    subgraph 浏览器["浏览器（前端）"]
        A[用户操作]
        B[Mock 业务数据<br/>localStorage]
        C[候选快照<br/>身份/权限/版本]
        D[响应校验<br/>结构/排序/分数]
    end

    subgraph 代理层["Vite 代理"]
        E["/retrieval 同源转发"]
    end

    subgraph 检索服务["Python 检索服务"]
        F[参数限制<br/>长度/数量/大小]
        G[并发控制<br/>单任务 429]
        H[模型推理<br/>CPU 线程池]
        I[LRU 缓存<br/>内容 hash 键]
    end

    A --> B
    B --> C
    C --> E
    E --> F
    F --> G
    G --> H
    H --> I
    I --> E
    E --> D
    D --> A

    style 浏览器 fill:#e8f4fd
    style 代理层 fill:#fff3e0
    style 检索服务 fill:#e8f5e9
```

**责任边界**：
- **前端**：管理用户、知识库、文档、会话等业务数据；负责授权检查、候选快照、响应校验
- **检索服务**：只接收查询和候选正文，不存业务记录，不访问数据库，不接收 API Key
- **代理层**：同源转发，不修改请求内容
- **检索服务仅绑定回环地址**，不向局域网暴露

---

## 4. 关键技术决策

| 决策 | 选择 | 理由 |
|---|---|---|
| 模型 | BAAI/bge-small-zh-v1.5 | 中文检索专用，512 维轻量，Apache-2.0 |
| 推理框架 | SentenceTransformers + CPU PyTorch | 生态成熟，CPU 推理足够测试场景 |
| 查询前缀 | `为这个句子生成表示以用于检索相关文章：` | BGE 官方推荐，非对称检索设计 |
| 相似度 | 归一化点积 = 余弦相似度 | L2 归一化后等价，计算高效 |
| 长文本 | Token 窗口切分（overlap=32） | 避免截断，保留边界上下文 |
| 缓存 | LRU 2048 条，内容 hash 键 | 有界内存，不持久化，重启清除 |
| 并发 | 单任务，繁忙 429 | CPU 推理资源有限，避免排队堆积 |
| 模式 | local/demo 双模式 | local 实际检索，demo 离线演示 |
| 校验 | 快照二次校验 | 防止检索期间数据变化导致不一致 |

---

## 5. 文件结构

```
模型管理系统/
├── README.md
├── HuggingFace小型Embedding与知识库检索实施方案.md    # 专项实施文档
── Embedding模型工作原理与检索闭环归档.md              # 本文档
├── .gitignore
├── backend/                                            # Python 本地检索服务
│   ├── app/
│   │   ├── config.py          # 配置（模型、维度、限制）
│   │   ├── schemas.py         # Pydantic DTO
│   │   ├── embedding.py       # 模型生命周期与编码
│   │   ├── retrieval.py       # LRU 缓存与检索
│   │   └── main.py            # FastAPI 路由
│   ├── tests/test_retrieval.py  # 20 项单测
│   ├── run.py                   # 启动入口
│   ├── requirements.txt
│   └── requirements-dev.txt
└── frontend/                                           # Vue 3 前端
    ├── vite.config.ts            # /retrieval 代理配置
    └── src/
        ├── types/retrieval.ts    # 检索类型定义
        ├── api/retrieval.ts      # HTTP 传输层
        ├── api/retrieval.test.ts # 48 项 API 测试
        ├── mock/retrieval.ts     # 共享检索模块
        ├── mock/retrieval.test.ts # 54 项模块测试
        ── components/
            └── KnowledgeRetrievalPanel.vue  # 检索测试区
```

---

## 6. 启动命令

```powershell
# 前端
npm --prefix ./frontend run dev          # http://localhost:5174

# 后端检索服务
python -m venv ./backend/.venv
& ./backend/.venv/Scripts/python.exe -m pip install -r ./backend/requirements.txt
& ./backend/.venv/Scripts/python.exe ./backend/run.py   # http://127.0.0.1:8001

# 测试
npm --prefix ./frontend test             # 248 项前端测试
& ./backend/.venv/Scripts/python.exe -m pytest ./backend/tests  # 20 项后端测试
```
