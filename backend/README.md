# Knowledge Retrieval Service · 本地检索服务

面向 [ModelSpace](../README.md) 前端的本机语义检索微服务。接收前端提交的候选文档片段与查询，使用 BGE 中文 Embedding 模型计算真实向量相似度，返回命中 ID 与分数。

**不是通用业务后端。** 不存业务数据、不接数据库、不处理认证、不执行 Rerank。仅绑定回环地址，不向局域网暴露。

---

## 1. 架构概览

```
┌─────────────────────────────────────────────────────────┐
│  frontend (Vue 3, localhost:5174)                       │
│  ┌──────────┐  ──────────────┐  ┌──────────────────┐  │
│  │ 检索测试区│  │  模拟对话     │  │ mock/retrieval.ts│  │
│  └────┬─────┘  └──────┬───────┘  └────────┬─────────┘  │
│       └──────────────────────────────────┘             │
│                        │ POST /retrieval/search          │
└────────────────────────┼────────────────────────────────┘
                         │ Vite 代理
┌────────────────────────┼────────────────────────────────┐
│  backend (FastAPI, 127.0.0.1:8001)                      │
│                        ▼                                │
│  ┌─────────────────────────────────────────────────┐    │
│  │ main.py  路由层                                   │    │
│  │   GET  /retrieval/health   健康检查               │    │
│  │   POST /retrieval/load     模型加载               │    │
│  │   POST /retrieval/search   语义检索               │    │
│  └──────────────┬──────────────────────────────────┘    │
│                 ▼                                        │
│  ┌──────────────────────┐  ┌──────────────────────┐     │
│  │ embedding.py         │  │ retrieval.py         │     │
│  │ · 模型生命周期        │  │ · LRU 缓存 (2048)    │     │
│  │ · Token 窗口切分      │  │ · 余弦相似度聚合      │     │
│  │ · CLS 池化 + L2 归一  │  │ · 单任务并发控制      │     │
│  └──────────┬───────────  └──────────┬───────────┘     │
│             ▼                          │                 │
│  ┌──────────────────────┐              │                 │
│  │ BAAI/bge-small-zh-v1.5│             │                 │
│  │ 512 维 · CPU · PyTorch│◄────────────┘                 │
│  └──────────────────────┘                                │
└─────────────────────────────────────────────────────────┘
```

### 1.1 核心模块

| 文件 | 行数 | 职责 |
|---|---|---|
| [config.py](app/config.py) | 32 | 模型 ID、维度、查询前缀、资源上限、服务地址 |
| [schemas.py](app/schemas.py) | 70 | Pydantic v2 DTO：请求/响应信封、字段校验规则 |
| [embedding.py](app/embedding.py) | 218 | 模型生命周期（lazy load）、token 窗口切分、CLS 池化、L2 归一化 |
| [retrieval.py](app/retrieval.py) | 143 | LRU 向量缓存、余弦相似度计算、单任务并发锁 |
| [main.py](app/main.py) | 249 | FastAPI 路由、Host/Origin 回环校验、请求体大小限制、错误响应 |
| [run.py](run.py) | 14 | uvicorn 启动入口 |
| [tests/test_retrieval.py](tests/test_retrieval.py) | 422 | 20 项 pytest 单测（fake encoder，不联网） |

### 1.2 请求处理流水线

```
请求进入
  │
  ├── 1. 请求体大小检查（中间件，>2MiB → 413）
  │
  ├── 2. Host/Origin 回环检查（非 localhost → 403）
  │
  ├── 3. Content-Type 检查（非 application/json → 415）
  │
  ├── 4. 模型状态检查（未加载 → 503）
  │
  ├── 5. 并发检查（繁忙 → 429）
  │
  ├── 6. JSON 解析（非法 → 400）
  │
  ├── 7. Pydantic 字段校验（topK/minScore/chunks 结构）
  │
  ├── 8. 业务规则校验（query 非空/长度、chunk ID 唯一、总长度）
  │
  ├── 9. 编码查询（加前缀，token 窗口切分）
  │
  ├── 10. 逐块编码（LRU 缓存命中跳过）
  │
  ├── 11. 归一化点积 → 余弦相似度
  │
  ├── 12. 过滤 minScore → 降序排序 → 取 topK
  │
  └── 13. 返回 {hits, modelId, elapsedMs, totalChunks}
```

---

## 2. HTTP 契约

### 2.1 成功与错误格式

所有响应均为 JSON。成功用 `{data: T}` 信封，错误用 `{error: {code, message}}` 信封。

```json
// 成功
{"data": {"status": "ready", "modelId": "BAAI/bge-small-zh-v1.5", "dimension": 512, "device": "cpu"}}

// 错误
{"error": {"code": "MODEL_NOT_LOADED", "message": "模型未加载"}}
```

不返回堆栈、正文、向量或密钥。

### 2.2 GET /retrieval/health

健康检查。始终返回 200，即使模型未加载或加载失败。

```json
{"data": {"status": "unloaded|loading|ready|error", "modelId": "BAAI/bge-small-zh-v1.5", "dimension": 512, "device": "cpu"}}
```

`error` 状态可附 `error` 字段说明失败原因。

### 2.3 POST /retrieval/load

请求 `{}`。启动模型后台加载。

| 当前状态 | 行为 | 响应码 |
|---|---|---|
| `unloaded` / `error` | 启动加载任务 | 202 |
| `loading` | 返回当前状态，不重复加载 | 202 |
| `ready` | 返回健康信息 | 200 |

需要 Host/Origin 回环校验。

### 2.4 POST /retrieval/search

```json
// 请求
{
  "query": "出差报销需要什么材料？",
  "topK": 5,
  "minScore": 0.3,
  "chunks": [
    {"id": "c1", "content": "会议室需要提前预约。"},
    {"id": "c2", "content": "差旅报销需提交行程、发票及审批记录。"}
  ]
}
```

```json
// 响应
{
  "data": {
    "hits": [{"id": "c2", "score": 0.7507}],
    "modelId": "BAAI/bge-small-zh-v1.5",
    "dimension": 512,
    "elapsedMs": 55.77,
    "totalChunks": 2
  }
}
```

**约束**：

| 参数 | 限制 | 超限响应 |
|---|---|---|
| query | 非空，≤2000 码点 | 422 |
| topK | 整数 1–20 | 422 |
| minScore | 有限数 [-1, 1] | 422 |
| chunks | ≤512 条 | 413 |
| chunk.id | 非空、唯一 | 422 |
| chunk.content | 非空，≤4000 码点/条 | 422 / 413 |
| 总 content | ≤200000 码点 | 413 |
| 请求体 | ≤2 MiB | 413 |

### 2.5 状态码与错误码

| HTTP | code | 含义 |
|---|---|---|
| 400 | `INVALID_JSON` | JSON 解析失败 |
| 403 | `LOCAL_ACCESS_ONLY` | Host/Origin 非回环地址 |
| 413 | `REQUEST_TOO_LARGE` / `CANDIDATE_LIMIT_EXCEEDED` | 请求体或候选超限 |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Content-Type 非 JSON |
| 422 | `VALIDATION_ERROR` | 参数校验失败（空 query、重复 ID 等） |
| 429 | `RETRIEVAL_BUSY` | 前一个检索任务未完成 |
| 503 | `MODEL_NOT_LOADED` / `MODEL_LOADING` / `MODEL_LOAD_FAILED` | 模型状态异常 |
| 500 | `ENCODING_FAILED` | 编码过程异常 |

---

## 3. Embedding 模型

### 3.1 选型

| 项目 | 值 |
|---|---|
| 模型 | `BAAI/bge-small-zh-v1.5` |
| 来源 | [Hugging Face](https://huggingface.co/BAAI/bge-small-zh-v1.5) |
| 许可证 | Apache-2.0 |
| 维度 | 512 |
| 最大序列长度 | 512 tokens |
| 架构 | BERT 12 层，CLS 池化 |
| 推理设备 | CPU（PyTorch） |

### 3.2 查询前缀

BGE 采用非对称检索设计，查询必须添加前缀：

```
为这个句子生成表示以用于检索相关文章：
```

文档片段不加前缀。该前缀在模型预训练时学习，引导编码器生成更适合检索的查询表示。

### 3.3 相似度计算

向量经 L2 归一化后，点积等于余弦相似度：

```
sim(q, d) = q · d    (当 ‖q‖ = ‖d‖ = 1)
```

范围 [-1, 1]，1 为完全一致，0 为无关。本项目默认阈值 0.3。

### 3.4 长文本窗口切分

超过 512 tokens 的文本按 token 窗口切分，窗口重叠 32 tokens：

```
[token_1 ... token_510]  → 编码 → vec_1
         [token_479 ... token_510 ... token_989]  → 编码 → vec_2
                              [token_958 ... ]  → 编码 → vec_3

最终向量 = L2_normalize(mean(vec_1, vec_2, vec_3))
```

---

## 4. 模型下载与外置模型

### 4.1 自动下载（代码内嵌）

服务启动后，用户在前端点击“加载模型”触发 `POST /retrieval/load`，后端调用 [embedding.py](app/embedding.py#L91-L98) 的 `_load_model_sync`：

```python
def _load_model_sync(self) -> SentenceTransformer:
    model_path = config.MODEL_PATH if config.MODEL_PATH else config.MODEL_ID
    return SentenceTransformer(
        model_path,
        cache_folder=config.CACHE_DIR,
        device="cpu",
    )
```

**逻辑流程**：

```
config.MODEL_PATH 是否设置？
  ├─ 是 → SentenceTransformer(MODEL_PATH, ...)  ← 从本地目录加载
  └─ 否 → SentenceTransformer(MODEL_ID, cache_folder=CACHE_DIR)
           │
           ├─ 缓存中已存在 → 直接加载
           └─ 缓存中不存在 → huggingface_hub 自动下载
               │
               ├─ 默认缓存: backend/.cache/huggingface/
               ├─ HF_ENDPOINT 环境变量可指定镜像
               └─ 下载后存储结构:
                   .cache/huggingface/
                   └── models--BAAI--bge-small-zh-v1.5/
                       └── snapshots/
                           └── 7999e1d3.../   ← revision
                               ├── config.json
                               ├── pytorch_model.bin
                               ├── vocab.txt
                               └── ...
```

**关键点**：
- 下载由 `huggingface_hub` 库在 `SentenceTransformer()` 构造时自动触发
- 下载过程在后台线程执行，不阻塞 `GET /retrieval/health`
- 下载完成后自动验证维度（512）、有限值、非零向量
- 缓存目录可通过 `HF_CACHE_DIR` 环境变量覆盖

### 4.2 外置模型（MODEL_PATH）

当 `MODEL_PATH` 环境变量设置时，服务跳过 Hugging Face 下载，直接从指定目录加载：

```powershell
# 方式1：环境变量
$env:MODEL_PATH = "C:\models\bge-small-zh-v1.5"
python run.py

# 方式2：.env 文件
echo 'MODEL_PATH=C:\models\bge-small-zh-v1.5' > .env
python run.py
```

**目录结构要求**（SentenceTransformer 标准格式）：

```
/path/to/model/
├── config.json              # 模型配置
├── pytorch_model.bin        # 权重文件
├── vocab.txt                # 词表
├── tokenizer_config.json    # Tokenizer 配置
├── modules.json             # ST 模块定义
└── 1_Pooling/
    └── config.json          # 池化层配置
```

**加载逻辑**：

```python
# config.py
MODEL_PATH = os.environ.get("MODEL_PATH")  # 未设置时为 None

# embedding.py
model_path = config.MODEL_PATH if config.MODEL_PATH else config.MODEL_ID
# MODEL_PATH 有值 → 直接加载该目录，不联网
# MODEL_PATH 为空 → 使用 MODEL_ID 从 HF 下载
```

**使用场景**：
- 离线环境（无外网访问）
- 使用自定义微调模型
- 模型版本固定（不依赖 HF 自动更新）
- 网络不稳定时预下载

### 4.3 模型下载脚本

项目提供 [scripts/download_model.py](scripts/download_model.py) 脚本，支持自动下载、完整性验证和多种配置：

```powershell
# 基本用法：下载到项目默认缓存目录
& .\.venv\Scripts\python.exe scripts/download_model.py

# 指定模型和版本
& .\.venv\Scripts\python.exe scripts/download_model.py --revision 7999e1d3

# 使用 HF 镜像
& .\.venv\Scripts\python.exe scripts/download_model.py --hf-endpoint https://hf-mirror.com

# 下载到指定本地目录（非 HF 缓存结构）
& .\.venv\Scripts\python.exe scripts/download_model.py --local-dir ./models/bge

# 仅验证已有模型完整性
& .\.venv\Scripts\python.exe scripts/download_model.py --verify-only

# 强制重新下载
& .\.venv\Scripts\python.exe scripts/download_model.py --force
```

**脚本功能**：

| 功能 | 实现 |
|---|---|
| 下载 | `huggingface_hub.snapshot_download` |
| 缓存目录解析 | CLI 参数 > `HF_CACHE_DIR` > 项目默认 |
| 本地目录解析 | CLI 参数 > `MODEL_PATH` |
| 完整性验证 | 检查 6 个关键文件是否存在 |
| 缓存查找 | 解析 HF 缓存结构 `models--{org}--{repo}/snapshots/{revision}/` |
| 镜像支持 | `--hf-endpoint` 设置 `HF_ENDPOINT` |

**验证的关键文件**：

```
config.json
pytorch_model.bin
vocab.txt
tokenizer_config.json
modules.json
1_Pooling/config.json
```

下载完成后脚本自动验证，输出使用方式提示：

```
验证通过: 所有 6 个关键文件存在。

使用方式:
  方式1（自动）: 不设置 MODEL_PATH，服务自动从缓存加载
  方式2（手动）: 设置 MODEL_PATH=C:\...\snapshots\7999e1d3...
```

### 4.4 下载脚本测试

[tests/test_download_model.py](tests/test_download_model.py) 包含 29 项测试，覆盖：

| 测试类 | 数量 | 覆盖内容 |
|---|---|---|
| `TestGetCacheDir` | 4 | 默认/CLI/环境变量/优先级 |
| `TestGetLocalDir` | 4 | 默认 None/CLI/环境变量/优先级 |
| `TestVerifyModel` | 5 | 完整/缺文件/缺 pooling/空目录/不存在 |
| `TestFindModelInCache` | 5 | 未下载/找到/指定 revision/revision 不存在/最新快照 |
| `TestBuildParser` | 2 | 默认参数/所有选项 |
| `TestMainVerifyOnly` | 3 | 验证通过/缺失/未找到 |
| `TestMainDownload` | 6 | 下载验证/文件不完整/revision/镜像/本地目录/强制 |

所有测试使用 mock `huggingface_hub.snapshot_download`，不联网。

```powershell
# 运行下载脚本测试
& .\.venv\Scripts\python.exe -m pytest tests/test_download_model.py -v

# 运行全部后端测试（49 项）
& .\.venv\Scripts\python.exe -m pytest tests -v
```

### 4.5 常见问题

#### Q: 无参数执行 `download_model.py` 的完整流程是什么？

```
main(argv=None)
  │
  ├─ 1. build_parser()
  │     解析默认参数:
  │     model_id    = "BAAI/bge-small-zh-v1.5"    ← config.MODEL_ID
  │     cache_dir   = None                         ← 后续解析为项目默认
  │     revision    = None
  │     hf_endpoint = None (或 HF_ENDPOINT 环境变量)
  │     local_dir   = None
  │     verify_only = False
  │     force       = False
  │
  ├─ 2. get_cache_dir(None)
  │     → config.CACHE_DIR
  │     → backend/.cache/huggingface               ← 项目默认缓存目录
  │
  ├─ 3. get_local_dir(None)
  │     → os.environ.get("MODEL_PATH") 或 None
  │
  ├─ 4. find_model_in_cache("BAAI/bge-small-zh-v1.5", cache_dir, None)
  │     查找 backend/.cache/huggingface/models--BAAI--bge-small-zh-v1.5/snapshots/
  │     │
  │     ├─ 已存在 → target_dir = 该快照目录
  │     └─ 不存在 → target_dir = None
  │
  ├─ 5. verify_only = False，跳过验证分支
  │
  ├─ 6. download_model(...)
  │     调用 huggingface_hub.snapshot_download(
  │       repo_id="BAAI/bge-small-zh-v1.5",
  │       cache_dir="backend/.cache/huggingface",
  │       force_download=False,
  │     )
  │     │
  │     ├─ 缓存命中 → 秒级返回已有路径
  │     └─ 缓存未命中 → 从 HF 下载约 90MB → 存入缓存
  │
  ├─ 7. verify_model(result)
  │     检查 6 个关键文件:
  │     config.json, pytorch_model.bin, vocab.txt,
  │     tokenizer_config.json, modules.json, 1_Pooling/config.json
  │     │
  │     ├─ 全部存在 → 验证通过
  │     └─ 有缺失 → 警告 + 返回 1
  │
  ─ 8. 输出使用提示
        方式1（自动）: 不设置 MODEL_PATH，服务自动从缓存加载
        方式2（手动）: 设置 MODEL_PATH=<下载路径>
```

**首次运行**（需下载）：下载约 90MB → 验证 6 文件 → 输出使用提示。

**再次运行**（缓存命中）：`snapshot_download` 自动检测已有缓存，秒级返回 → 验证通过。

#### Q: 脚本中默认值的生效逻辑是怎样的？

三层优先级，从高到低：

```
优先级 1: CLI 参数（用户显式指定）
优先级 2: 环境变量（系统/会话配置）
优先级 3: 代码常量（config.py 硬编码）
```

各参数的具体来源：

| 参数 | CLI | 环境变量 | 代码默认 |
|---|---|---|---|
| `--model-id` | `--model-id X` | — | `config.MODEL_ID` |
| `--cache-dir` | `--cache-dir X` | `HF_CACHE_DIR` | `config.CACHE_DIR` |
| `--revision` | `--revision X` | — | `None`（HF 最新） |
| `--hf-endpoint` | `--hf-endpoint X` | `HF_ENDPOINT` | `None`（HF 官方） |
| `--local-dir` | `--local-dir X` | `MODEL_PATH` | `None`（HF 缓存结构） |
| `--verify-only` | `--verify-only` | — | `False` |
| `--force` | `--force` | — | `False` |

**关键设计点**：

1. **`config.py` 是唯一真相源**——`MODEL_ID`、`CACHE_DIR` 等常量在 `config.py` 定义，脚本和 `embedding.py` 共享同一套默认值，保证行为一致。
2. **环境变量在两个时机读取**：
   - `hf-endpoint`：脚本启动时 `argparse` 读取（静态）
   - `cache-dir` / `local-dir`：`get_*_dir()` 函数运行时读取（动态）
3. **`None` 是有意义的默认值**——`local-dir=None` 不是"未设置"，而是"使用 HF 标准缓存结构"的显式选择。

#### Q: `config.MODEL_ID` 的值从哪里来？

**硬编码**在 [config.py 第 6 行](app/config.py#L6)：

```python
MODEL_ID = "BAAI/bge-small-zh-v1.5"
```

不是从文件、环境变量或网络读取——就是代码中的字面量常量。

**为什么这样设计**：

| 配置项 | 来源 | 原因 |
|---|---|---|
| `MODEL_ID` | 代码硬编码 | 模型选型是架构决策，不应运行时变更 |
| `DIMENSION` | 代码硬编码 | 与模型绑定，512 维是模型自身属性 |
| `QUERY_PREFIX` | 代码硬编码 | BGE 官方推荐前缀，与模型配对 |
| `CACHE_DIR` | 环境变量 > 代码默认 | 部署路径可能不同 |
| `MODEL_PATH` | 环境变量 | 外置模型路径由运维决定 |
| `HOST` / `PORT` | 代码硬编码 | 回环测试服务，固定 8001 |

如果要换模型，需要同时修改 `MODEL_ID`、`DIMENSION`、`QUERY_PREFIX` 三个常量——它们是耦合的，所以放在同一处集中管理。

---

## 5. 环境配置

### 5.1 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `MODEL_PATH` | 未设置 | 设置时从本地目录加载模型，路径无效不联网回退 |
| `HF_CACHE_DIR` | `./.cache/huggingface` | 模型缓存目录 |
| `HF_ENDPOINT` | 官方默认 | 仅允许操作者显式指定镜像，不自动切换 |

通过 `.env` 文件或系统环境变量设置。参考 [.env.example](.env.example)。

### 5.2 配置常量（config.py）

```python
MODEL_ID = "BAAI/bge-small-zh-v1.5"
DIMENSION = 512
QUERY_PREFIX = "为这个句子生成表示以用于检索相关文章："
MAX_CHUNKS = 512
MAX_CHUNK_CONTENT = 4000
MAX_TOTAL_CONTENT = 200000
MAX_QUERY_LENGTH = 2000
MAX_REQUEST_BYTES = 2 * 1024 * 1024  # 2 MiB
LRU_CAPACITY = 2048
HOST = "127.0.0.1"
PORT = 8001
```

---

## 6. 本地测试

### 6.1 环境准备

```powershell
# 进入 backend 目录
cd backend

# 创建虚拟环境
python -m venv .venv

# 激活虚拟环境
& .\.venv\Scripts\Activate.ps1

# 安装运行依赖
pip install -r requirements.txt

# 安装 CPU 版 PyTorch（避免下载 CUDA 版本）
pip install -r requirements-cpu.txt

# 安装测试依赖
pip install -r requirements-dev.txt

# 验证依赖完整性
pip check
```

### 6.2 运行单测

```powershell
# 全部测试（20 项，fake encoder，不联网）
python -m pytest tests -v

# 按类运行
python -m pytest tests -v -k TestHealthEndpoint
python -m pytest tests -v -k TestLoadEndpoint
python -m pytest tests -v -k TestSearchEndpoint
python -m pytest tests -v -k TestLRUCache
python -m pytest tests -v -k TestConcurrency
python -m pytest tests -v -k TestHostOriginCheck

# 带覆盖率
pip install pytest-cov
python -m pytest tests --cov=app --cov-report=term-missing
```

**测试分类**：

| 测试类 | 数量 | 覆盖内容 |
|---|---|---|
| `TestHealthEndpoint` | 2 | 初始状态、错误状态 |
| `TestLoadEndpoint` | 4 | 从未加载加载、已就绪、非法 JSON、错误 Content-Type |
| `TestSearchEndpoint` | 7 | 模型未加载、空 query、非法 topK/minScore、空候选、带候选检索、重复 ID |
| `TestLRUCache` | 4 | 缓存命中、未命中、淘汰、内容哈希 |
| `TestConcurrency` | 1 | 并发 429 |
| `TestHostOriginCheck` | 2 | 非本地 Host、非本地 Origin |

### 6.3 启动服务并手动验证

```powershell
# 启动服务
python run.py

# 另开终端验证
# 健康检查
Invoke-RestMethod http://127.0.0.1:8001/retrieval/health

# 加载模型（首次约 1-3 分钟下载）
Invoke-RestMethod -Method Post http://127.0.0.1:8001/retrieval/load -ContentType application/json -Body '{}'

# 等待模型就绪后检索
$body = @{
    query = "差旅报销需要什么材料"
    topK = 5
    minScore = 0.3
    chunks = @(
        @{id="c1"; content="会议室需要提前预约。"},
        @{id="c2"; content="差旅报销需提交行程、发票及审批记录。"},
        @{id="c3"; content="数据库每天备份并定期验证恢复。"}
    )
} | ConvertTo-Json -Depth 3

Invoke-RestMethod -Method Post http://127.0.0.1:8001/retrieval/search -ContentType application/json -Body $body
```

预期输出：c2（差旅相关）score ≈ 0.75 排首位，c1（会议室）≈ 0.30 次之，c3 被阈值过滤。

### 6.4 冒烟测试

```powershell
# 使用真实模型进行端到端验证（需模型已下载）
python scripts/smoke_retrieval.py
```

---

## 7. 本地部署

### 7.1 开发模式

```powershell
cd backend
python -m venv .venv
& .\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
pip install -r requirements-cpu.txt
python run.py
```

服务启动在 `127.0.0.1:8001`。前端通过 Vite 代理 `/retrieval` 转发到该地址。

### 7.2 生产考量（本机测试服务）

本服务设计为**本机无鉴权测试服务**，不适合直接生产部署：

- 仅绑定 `127.0.0.1`，不监听 `0.0.0.0`
- 无认证机制，依赖回环地址隔离
- CPU 单任务并发，不支持高并发
- 向量缓存不持久化，重启清除

**生产部署需另行设计**：正式业务后端完成鉴权与候选读取，向量数据库持久化索引，GPU 推理加速，Rerank 重排序。

### 7.3 模型离线加载

若网络无法访问 Hugging Face，可手动下载模型后设置 `MODEL_PATH`：

```powershell
# 1. 从可联网机器下载模型到目录
# 2. 复制到 backend/.cache/huggingface/models--BAAI--bge-small-zh-v1.5/
# 3. 设置环境变量
$env:MODEL_PATH = "C:\Users\X\Desktop\模型管理系统\backend\.cache\huggingface\models--BAAI--bge-small-zh-v1.5"

# 4. 启动服务（将从本地目录加载，不联网）
python run.py
```

### 7.4 使用 HF 镜像

```powershell
$env:HF_ENDPOINT = "https://hf-mirror.com"
python run.py
```

---

## 8. 目录结构

```
backend/
├── README.md                    # 本文档
├── .env.example                 # 环境变量示例
├── run.py                       # 启动入口（uvicorn）
├── requirements.txt             # 运行依赖
├── requirements-cpu.txt         # CPU PyTorch（单独安装）
├── requirements-dev.txt         # 测试依赖（引用 requirements.txt）
├── pytest.ini                   # pytest 配置
├── app/
│   ├── __init__.py
│   ├── config.py                # 配置常量
│   ├── schemas.py               # Pydantic v2 DTO
│   ├── embedding.py             # 模型生命周期与编码
│   ├── retrieval.py             # LRU 缓存与检索
│   └── main.py                  # FastAPI 路由
├── tests/
│   ├── __init__.py
│   └── test_retrieval.py        # 20 项单测
└── .cache/                      # 不提交
    ├── huggingface/             # 模型权重缓存
    ── pytest-cache/            # pytest 缓存
```

---

## 9. 与前端集成

前端通过 Vite 代理访问本服务：

```typescript
// vite.config.ts
proxy: {
  '/retrieval': {
    target: 'http://127.0.0.1:8001',
    changeOrigin: true,
  },
}
```

前端代码通过 `/retrieval/health`、`/retrieval/load`、`/retrieval/search` 三个端点交互，详见 [api/retrieval.ts](../frontend/src/api/retrieval.ts)。

### 9.1 模式切换

| `VITE_RETRIEVAL_MODE` | 行为 |
|---|---|
| `local`（默认） | 调用本地检索服务，服务不可用时报错 |
| `demo` | 使用离线固定引用，不调用服务 |
| 其他值 | 启动时报错 |

### 9.2 前端健康轮询

前端检索测试区每 2 秒轮询 `/retrieval/health`，显示模型状态。用户点击"加载模型"触发 `POST /retrieval/load`，轮询持续直到状态变为 `ready` 或 `error`。

---

## 10. 常见问题

**Q: 模型加载失败怎么办？**
检查网络连通性。若 HF 不可达，设置 `HF_ENDPOINT` 镜像或 `MODEL_PATH` 指向本地模型目录。错误信息通过 `GET /retrieval/health` 的 `error` 字段返回。

**Q: 检索返回 429？**
CPU 单任务并发设计。等待前一个检索完成（通常 <100ms）后重试。

**Q: 分数为什么是负数？**
余弦相似度范围 [-1, 1]。负数表示语义相反方向。可通过 `minScore` 阈值过滤。

**Q: 如何更换模型？**
修改 `config.py` 中的 `MODEL_ID`、`DIMENSION`、`QUERY_PREFIX`。注意不同模型的前缀和维度可能不同。

**Q: 向量缓存会持久化吗？**
不会。LRU 缓存在内存中，服务重启后清除。缓存键为内容 SHA-256 摘要，不含原文。
