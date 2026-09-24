"""LRU 缓存与检索"""
import hashlib
import logging
import time
from collections import OrderedDict
from typing import Dict, List, Tuple

import numpy as np

from . import config
from .bm25 import BM25Scorer, tokenize_bigram
from .embedding import embedding_service
from .reranker import reranker_service
from .schemas import SearchRequest, SearchHit, SearchResponseData

logger = logging.getLogger(__name__)


def _normalize_score(score: float, score_type: str, max_score: float = 1.0) -> float:
    """
    将分数归一化到 [0, 100]
    
    Args:
        score: 原始分数
        score_type: 分数类型 ('vector', 'bm25', 'rrf', 'rerank')
        max_score: 该类型分数的理论最大值（用于归一化）
    
    Returns:
        归一化后的分数 ∈ [0, 100]
    """
    if score_type == 'vector':
        # 余弦相似度 [-1, 1] → 截断负值 → [0, 1] → * 100
        return max(0.0, min(1.0, score)) * 100.0
    elif score_type == 'rerank':
        # Reranker 归一化分数 [0, 1] → * 100
        return max(0.0, min(1.0, score)) * 100.0
    elif score_type in ('bm25', 'rrf'):
        # BM25/RRF 分数无上界或范围不定，按批次最大值归一化
        if max_score <= 0:
            return 0.0
        return max(0.0, (score / max_score) * 100.0)
    else:
        return score


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
        reranker_used = False

        try:
            hits, reranker_used = await self._do_search(request)
            elapsed_ms = (time.time() - start_time) * 1000

            return SearchResponseData(
                hits=hits,
                modelId=config.MODEL_ID,
                dimension=config.DIMENSION,
                elapsedMs=elapsed_ms,
                totalChunks=len(request.chunks),
                rerankerUsed=reranker_used,
            )
        finally:
            self._busy = False

    async def _do_search(self, request: SearchRequest) -> Tuple[List[SearchHit], bool]:
        """执行检索逻辑，返回 (hits, reranker_used)"""
        if not request.chunks:
            return [], False

        # 0. 过滤
        chunks = self._apply_filters(request.chunks, request)
        if not chunks:
            return [], False

        # 1. 向量检索（始终执行）→ 归一化到 [0, 100]
        vector_hits_raw = await self._vector_search(request.query, chunks)
        vector_hits = [(cid, _normalize_score(s, 'vector')) for cid, s in vector_hits_raw]

        # 2. BM25 检索（可选）→ 归一化到 [0, 100]
        bm25_hits: List[Tuple[str, float]] = []
        if request.enableBm25 and config.BM25_ENABLED:
            bm25_hits_raw = self._bm25_search(request.query, chunks)
            bm25_max = max((s for _, s in bm25_hits_raw), default=1.0)
            bm25_hits = [(cid, _normalize_score(s, 'bm25', bm25_max)) for cid, s in bm25_hits_raw]

        # 3. RRF 融合 → 归一化到 [0, 100]
        used_rrf = False
        if bm25_hits:
            fused_raw = self._rrf_fusion(vector_hits_raw, bm25_hits_raw)
            rrf_max = max((s for _, s in fused_raw), default=1.0)
            fused = [(cid, _normalize_score(s, 'rrf', rrf_max)) for cid, s in fused_raw]
            used_rrf = True
        else:
            fused = vector_hits

        # 4. Rerank（可选）→ 归一化到 [0, 100]
        reranker_used = False
        if request.enableRerank and config.RERANKER_ENABLED:
            try:
                fused_raw, reranker_used = await self._rerank(request.query, fused, chunks)
                if reranker_used:
                    fused = [(cid, _normalize_score(s, 'rerank')) for cid, s in fused_raw]
            except Exception:
                logger.warning("Rerank 失败，使用混合检索分数")

        # 5. 过滤 + 排序 + topK（所有分数已在 [0, 100]）
        # 使用 epsilon 容差确保边界值被包含（处理浮点精度问题）
        epsilon = 1e-9
        filtered = [(cid, score) for cid, score in fused if score >= request.minScore - epsilon]
        filtered.sort(key=lambda x: (-x[1], x[0]))
        top_k = filtered[: request.topK]

        # 构建原始分数查找表（用于调试）
        vec_raw_map = {cid: s for cid, s in vector_hits_raw}
        bm25_raw_map = {cid: s for cid, s in bm25_hits_raw} if bm25_hits else {}

        hits = []
        for cid, score in top_k:
            hits.append(SearchHit(
                id=cid,
                score=score,  # 已归一化到 [0, 100]
                vectorScore=vec_raw_map.get(cid),
                bm25Score=bm25_raw_map.get(cid) if bm25_raw_map else None,
                rerankScore=score if reranker_used else None,
            ))

        return hits, reranker_used

    async def _vector_search(
        self, query: str, chunks: List
    ) -> List[Tuple[str, float]]:
        """纯向量检索（原有逻辑提取）"""
        query_vecs = await self._encode_with_windows(query, is_query=True)

        chunk_scores = []
        for idx, chunk in enumerate(chunks):
            cache_key = _content_hash(chunk.content)
            hit, cached_vecs = self._cache.get(cache_key)

            if hit:
                chunk_vecs = cached_vecs
            else:
                chunk_vecs = await self._encode_with_windows(chunk.content, is_query=False)
                self._cache.put(cache_key, chunk_vecs)

            max_score = self._max_dot_product(chunk_vecs, query_vecs)
            chunk_scores.append((chunk.id, max_score))

        # 按分数降序，同分按输入顺序
        chunk_scores.sort(key=lambda x: -x[1])
        return chunk_scores

    def _apply_filters(self, chunks: List, request: SearchRequest) -> List:
        """按知识库/文档类型过滤"""
        filtered = chunks
        if request.knowledgeBaseIds:
            kb_set = set(request.knowledgeBaseIds)
            filtered = [c for c in filtered if c.knowledgeBaseId in kb_set]
        if request.documentTypes:
            type_set = set(request.documentTypes)
            filtered = [c for c in filtered if c.documentType in type_set]
        return filtered

    def _bm25_search(
        self, query: str, chunks: List
    ) -> List[Tuple[str, float]]:
        """BM25 关键词检索"""
        documents = [c.content for c in chunks]
        scorer = BM25Scorer()
        scorer.build_index(documents)
        scores = scorer.score_batch(query, documents)
        result = [(chunks[i].id, float(s)) for i, s in enumerate(scores) if s > 0]
        result.sort(key=lambda x: -x[1])
        return result

    def _rrf_fusion(
        self,
        vector_hits: List[Tuple[str, float]],
        bm25_hits: List[Tuple[str, float]],
    ) -> List[Tuple[str, float]]:
        """Reciprocal Rank Fusion"""
        k = config.RRF_K
        scores: Dict[str, float] = {}
        for rank, (cid, _score) in enumerate(vector_hits):
            scores[cid] = scores.get(cid, 0.0) + config.VECTOR_WEIGHT / (k + rank + 1)
        for rank, (cid, _score) in enumerate(bm25_hits):
            scores[cid] = scores.get(cid, 0.0) + config.BM25_WEIGHT / (k + rank + 1)
        fused = sorted(scores.items(), key=lambda x: -x[1])
        return fused

    async def _rerank(
        self,
        query: str,
        fused: List[Tuple[str, float]],
        chunks: List,
    ) -> Tuple[List[Tuple[str, float]], bool]:
        """Rerank 重排序，返回 (新融合列表, reranker_used)"""
        # 限制送入 Reranker 的候选数，避免 CPU 爆满
        max_candidates = min(config.RERANKER_TOP_N, len(fused))
        fused = fused[:max_candidates]

        chunk_map = {c.id: c.content for c in chunks}
        ids = [cid for cid, _ in fused]
        passages = [chunk_map[cid] for cid in ids if cid in chunk_map]

        if not passages:
            return fused, False

        try:
            # 使用配置的超时时间
            ranked = await reranker_service.rerank(
                query, passages, top_k=len(passages),
                timeout=config.RERANKER_TIMEOUT,
            )

            # ranked: [(原始索引, 分数), ...]
            reranked_ids = [(ids[orig_idx], score) for orig_idx, score in ranked]
            return reranked_ids, True
        except Exception as e:
            logger.warning(f"Rerank 失败，使用混合检索分数：{e}")
            return fused, False

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
