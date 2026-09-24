"""LRU 缓存与检索"""
import hashlib
import time
from collections import OrderedDict
from typing import List, Dict, Tuple

import numpy as np

from . import config
from .embedding import embedding_service
from .schemas import SearchRequest, SearchHit, SearchResponseData


class LRUCache:
    """LRU 缓存"""

    def __init__(self, capacity: int):
        self.capacity = capacity
        self._cache: OrderedDict[str, np.ndarray] = OrderedDict()

    def get(self, key: str) -> Tuple[bool, np.ndarray]:
        """获取缓存，返回 (命中, 向量)"""
        if key in self._cache:
            self._cache.move_to_end(key)
            return True, self._cache[key]
        return False, None

    def put(self, key: str, value: np.ndarray):
        """放入缓存"""
        if key in self._cache:
            self._cache.move_to_end(key)
            self._cache[key] = value
        else:
            if len(self._cache) >= self.capacity:
                self._cache.popitem(last=False)
            self._cache[key] = value


def _content_hash(content: str) -> str:
    """计算内容摘要（sha256 前 16 字节 hex）"""
    return hashlib.sha256(content.encode("utf-8")).hexdigest()[:32]


class RetrievalService:
    """检索服务"""

    def __init__(self):
        self._cache = LRUCache(config.LRU_CAPACITY)
        self._busy = False

    @property
    def is_busy(self) -> bool:
        return self._busy

    async def search(self, request: SearchRequest) -> SearchResponseData:
        """执行检索"""
        if self._busy:
            raise RuntimeError("RETRIEVAL_BUSY")

        self._busy = True
        start_time = time.time()

        try:
            hits = await self._do_search(request)
            elapsed_ms = (time.time() - start_time) * 1000

            return SearchResponseData(
                hits=hits,
                modelId=config.MODEL_ID,
                dimension=config.DIMENSION,
                elapsedMs=elapsed_ms,
                totalChunks=len(request.chunks),
            )
        finally:
            self._busy = False

    async def _do_search(self, request: SearchRequest) -> List[SearchHit]:
        """执行检索逻辑"""
        if not request.chunks:
            return []

        # 编码查询
        query_vecs = await self._encode_with_windows(request.query, is_query=True)

        # 编码文档块
        chunk_scores = []
        for idx, chunk in enumerate(request.chunks):
            # 检查缓存
            cache_key = _content_hash(chunk.content)
            hit, cached_vecs = self._cache.get(cache_key)

            if hit:
                chunk_vecs = cached_vecs
            else:
                # 编码并缓存
                chunk_vecs = await self._encode_with_windows(chunk.content, is_query=False)
                self._cache.put(cache_key, chunk_vecs)

            # 计算最大点积（所有窗口与所有查询窗口的最大点积）
            max_score = self._max_dot_product(chunk_vecs, query_vecs)
            chunk_scores.append((idx, chunk.id, max_score))

        # 过滤和排序
        filtered = [
            (idx, cid, score)
            for idx, cid, score in chunk_scores
            if score >= request.minScore
        ]

        # 降序排序，同分按输入顺序
        filtered.sort(key=lambda x: (-x[2], x[0]))

        # 取 topK
        top_k = filtered[: request.topK]

        return [SearchHit(id=cid, score=float(score)) for _, cid, score in top_k]

    async def _encode_with_windows(self, text: str, is_query: bool) -> np.ndarray:
        """编码文本（支持长文本窗口切分）"""
        # 使用 embedding service 的编码方法
        vec = await embedding_service.encode([text], is_query=is_query)
        return vec

    def _max_dot_product(self, doc_vecs: np.ndarray, query_vecs: np.ndarray) -> float:
        """计算文档向量与查询向量的最大点积"""
        # 如果都是 1D，直接点积
        if doc_vecs.ndim == 1:
            doc_vecs = doc_vecs.reshape(1, -1)
        if query_vecs.ndim == 1:
            query_vecs = query_vecs.reshape(1, -1)

        # 计算所有对之间的点积
        # doc_vecs: (n_doc, dim), query_vecs: (n_query, dim)
        # 结果: (n_doc, n_query)
        dot_products = np.dot(doc_vecs, query_vecs.T)

        # 返回最大值
        return float(np.max(dot_products))


# 全局实例
retrieval_service = RetrievalService()
