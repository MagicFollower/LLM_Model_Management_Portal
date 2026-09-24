"""配置模块"""
import os
from pathlib import Path

# 模型配置
MODEL_ID = "BAAI/bge-small-zh-v1.5"
DIMENSION = 512
QUERY_PREFIX = "为这个句子生成表示以用于检索相关文章："

# 缓存目录
CACHE_DIR = os.environ.get(
    "HF_CACHE_DIR",
    str(Path(__file__).parent.parent / ".cache" / "huggingface")
)

# 本地模型路径（可选）
MODEL_PATH = os.environ.get("MODEL_PATH")

# 限制配置
MAX_CHUNKS = 512
MAX_CHUNK_CONTENT = 4000
MAX_TOTAL_CONTENT = 200000
MAX_QUERY_LENGTH = 2000
MAX_REQUEST_BYTES = 2 * 1024 * 1024  # 2MiB

# LRU 缓存容量
LRU_CAPACITY = 2048

# 服务配置
HOST = "127.0.0.1"
PORT = 8001

# BM25 配置
BM25_ENABLED = os.environ.get("BM25_ENABLED", "false").lower() == "true"

# Reranker 配置
RERANKER_MODEL_ID = "BAAI/bge-reranker-v2-m3"
RERANKER_MODEL_PATH = os.environ.get("RERANKER_MODEL_PATH")
RERANKER_ENABLED = os.environ.get("RERANKER_ENABLED", "false").lower() == "true"
RERANKER_TOP_N = int(os.environ.get("RERANKER_TOP_N", "20"))
RERANKER_TIMEOUT = int(os.environ.get("RERANKER_TIMEOUT", "30"))  # 秒
RERANKER_BATCH_SIZE = int(os.environ.get("RERANKER_BATCH_SIZE", "8"))  # 批处理大小

# 混合检索权重
BM25_WEIGHT = float(os.environ.get("BM25_WEIGHT", "0.3"))
VECTOR_WEIGHT = float(os.environ.get("VECTOR_WEIGHT", "0.7"))
RRF_K = 60  # RRF 常数
