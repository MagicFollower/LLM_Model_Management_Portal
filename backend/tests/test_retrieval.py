"""检索服务测试"""
import asyncio
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
import numpy as np

from httpx import AsyncClient, ASGITransport

from app.main import app
from app.embedding import embedding_service, ModelState
from app.retrieval import retrieval_service, _content_hash
from app.reranker import reranker_service, RerankerState, RerankerService


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
def reset_services():
    """重置服务状态"""
    embedding_service._state = ModelState.UNLOADED
    embedding_service._model = None
    embedding_service._error = None
    embedding_service._load_task = None
    retrieval_service._busy = False
    retrieval_service._cache = retrieval_service._cache.__class__(2048)
    reranker_service._state = RerankerState.UNLOADED
    reranker_service._model = None
    reranker_service._error = None
    yield


class TestHealthEndpoint:
    """健康检查测试"""

    @pytest.mark.anyio
    async def test_health_initial_state(self):
        """测试初始状态"""
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/retrieval/health")

        assert response.status_code == 200
        data = response.json()
        assert data["data"]["status"] == "unloaded"
        assert data["data"]["modelId"] == "BAAI/bge-small-zh-v1.5"
        assert data["data"]["dimension"] == 512
        assert data["data"]["device"] == "cpu"

    @pytest.mark.anyio
    async def test_health_error_state(self):
        """测试错误状态"""
        embedding_service._state = ModelState.ERROR
        embedding_service._error = "测试错误"

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/retrieval/health")

        assert response.status_code == 200
        data = response.json()
        assert data["data"]["status"] == "error"
        assert data["data"]["error"] == "测试错误"


class TestLoadEndpoint:
    """加载端点测试"""

    @pytest.mark.anyio
    async def test_load_from_unloaded(self):
        """测试从未加载状态加载"""
        with patch.object(embedding_service, "_do_load", new_callable=AsyncMock) as mock_load:
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://127.0.0.1:8001") as client:
                response = await client.post(
                    "/retrieval/load",
                    headers={"content-type": "application/json", "host": "127.0.0.1:8001"},
                    content="{}",
                )

            assert response.status_code == 202
            data = response.json()
            assert data["data"]["status"] in ["loading", "ready"]

    @pytest.mark.anyio
    async def test_load_already_ready(self):
        """测试已就绪时加载"""
        embedding_service._state = ModelState.READY

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://127.0.0.1:8001") as client:
            response = await client.post(
                "/retrieval/load",
                headers={"content-type": "application/json", "host": "127.0.0.1:8001"},
                content="{}",
            )

        assert response.status_code == 200
        data = response.json()
        assert data["data"]["status"] == "ready"

    @pytest.mark.anyio
    async def test_load_invalid_json(self):
        """测试无效 JSON"""
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://127.0.0.1:8001") as client:
            response = await client.post(
                "/retrieval/load",
                headers={"content-type": "application/json", "host": "127.0.0.1:8001"},
                content="invalid json",
            )

        assert response.status_code == 400
        data = response.json()
        assert data["error"]["code"] == "INVALID_JSON"

    @pytest.mark.anyio
    async def test_load_wrong_content_type(self):
        """测试错误的 Content-Type"""
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://127.0.0.1:8001") as client:
            response = await client.post(
                "/retrieval/load",
                headers={"content-type": "text/plain", "host": "127.0.0.1:8001"},
                content="{}",
            )

        assert response.status_code == 415
        data = response.json()
        assert data["error"]["code"] == "UNSUPPORTED_MEDIA_TYPE"


class TestSearchEndpoint:
    """检索端点测试"""

    @pytest.mark.anyio
    async def test_search_model_not_loaded(self):
        """测试模型未加载时检索"""
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://127.0.0.1:8001") as client:
            response = await client.post(
                "/retrieval/search",
                headers={"content-type": "application/json", "host": "127.0.0.1:8001"},
                json={
                    "query": "测试",
                    "topK": 5,
                    "minScore": 0.5,
                    "chunks": [],
                },
            )

        assert response.status_code == 503
        data = response.json()
        assert data["error"]["code"] == "MODEL_NOT_LOADED"

    @pytest.mark.anyio
    async def test_search_invalid_query_empty(self):
        """测试空 query"""
        embedding_service._state = ModelState.READY

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://127.0.0.1:8001") as client:
            response = await client.post(
                "/retrieval/search",
                headers={"content-type": "application/json", "host": "127.0.0.1:8001"},
                json={
                    "query": "",
                    "topK": 5,
                    "minScore": 0.5,
                    "chunks": [],
                },
            )

        assert response.status_code == 422
        data = response.json()
        assert data["error"]["code"] == "VALIDATION_ERROR"

    @pytest.mark.anyio
    async def test_search_invalid_topk(self):
        """测试非法 topK"""
        embedding_service._state = ModelState.READY

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://127.0.0.1:8001") as client:
            response = await client.post(
                "/retrieval/search",
                headers={"content-type": "application/json", "host": "127.0.0.1:8001"},
                json={
                    "query": "测试",
                    "topK": 0,
                    "minScore": 0.5,
                    "chunks": [],
                },
            )

        assert response.status_code == 422

    @pytest.mark.anyio
    async def test_search_invalid_minscore(self):
        """测试非法 minScore"""
        embedding_service._state = ModelState.READY

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://127.0.0.1:8001") as client:
            response = await client.post(
                "/retrieval/search",
                headers={"content-type": "application/json", "host": "127.0.0.1:8001"},
                json={
                    "query": "测试",
                    "topK": 5,
                    "minScore": 2.0,
                    "chunks": [],
                },
            )

        assert response.status_code == 422

    @pytest.mark.anyio
    async def test_search_empty_chunks(self):
        """测试空候选列表"""
        embedding_service._state = ModelState.READY

        # Mock encode 方法
        with patch.object(embedding_service, "encode", new_callable=AsyncMock) as mock_encode:
            mock_encode.return_value = np.zeros((1, 512), dtype=np.float32)

            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://127.0.0.1:8001") as client:
                response = await client.post(
                    "/retrieval/search",
                    headers={"content-type": "application/json", "host": "127.0.0.1:8001"},
                    json={
                        "query": "测试",
                        "topK": 5,
                        "minScore": 0.5,
                        "chunks": [],
                    },
                )

        assert response.status_code == 200
        data = response.json()
        assert data["data"]["hits"] == []
        assert data["data"]["totalChunks"] == 0

    @pytest.mark.anyio
    async def test_search_with_chunks(self):
        """测试带文档块的检索"""
        embedding_service._state = ModelState.READY

        # Mock encode 方法
        async def mock_encode(texts, is_query=False):
            n = len(texts)
            # 返回不同的向量
            vecs = np.random.randn(n, 512).astype(np.float32)
            vecs /= np.linalg.norm(vecs, axis=1, keepdims=True)
            return vecs

        with patch.object(embedding_service, "encode", new_callable=AsyncMock, side_effect=mock_encode):
            transport = ASGITransport(app=app)
            async with AsyncClient(transport=transport, base_url="http://127.0.0.1:8001") as client:
                response = await client.post(
                    "/retrieval/search",
                    headers={"content-type": "application/json", "host": "127.0.0.1:8001"},
                    json={
                        "query": "测试",
                        "topK": 5,
                        "minScore": 0.0,
                        "chunks": [
                            {"id": "1", "content": "内容1"},
                            {"id": "2", "content": "内容2"},
                        ],
                    },
                )

        assert response.status_code == 200
        data = response.json()
        assert len(data["data"]["hits"]) <= 2
        assert data["data"]["modelId"] == "BAAI/bge-small-zh-v1.5"
        assert data["data"]["dimension"] == 512

    @pytest.mark.anyio
    async def test_search_duplicate_chunk_ids(self):
        """测试重复的 chunk ID"""
        embedding_service._state = ModelState.READY

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://127.0.0.1:8001") as client:
            response = await client.post(
                "/retrieval/search",
                headers={"content-type": "application/json", "host": "127.0.0.1:8001"},
                json={
                    "query": "测试",
                    "topK": 5,
                    "minScore": 0.5,
                    "chunks": [
                        {"id": "1", "content": "内容1"},
                        {"id": "1", "content": "内容2"},
                    ],
                },
            )

        assert response.status_code == 422
        data = response.json()
        assert data["error"]["code"] == "VALIDATION_ERROR"


class TestLRUCache:
    """LRU 缓存测试"""

    def test_cache_hit(self):
        """测试缓存命中"""
        from app.retrieval import LRUCache

        cache = LRUCache(2)
        vec = np.array([1.0, 2.0, 3.0])

        cache.put("key1", vec)
        hit, cached = cache.get("key1")

        assert hit
        assert np.array_equal(cached, vec)

    def test_cache_miss(self):
        """测试缓存未命中"""
        from app.retrieval import LRUCache

        cache = LRUCache(2)
        hit, cached = cache.get("nonexistent")

        assert not hit
        assert cached is None

    def test_cache_eviction(self):
        """测试缓存淘汰"""
        from app.retrieval import LRUCache

        cache = LRUCache(2)
        cache.put("key1", np.array([1.0]))
        cache.put("key2", np.array([2.0]))
        cache.put("key3", np.array([3.0]))  # 应该淘汰 key1

        hit1, _ = cache.get("key1")
        hit3, _ = cache.get("key3")

        assert not hit1
        assert hit3

    def test_content_hash(self):
        """测试内容哈希"""
        hash1 = _content_hash("测试内容")
        hash2 = _content_hash("测试内容")
        hash3 = _content_hash("不同内容")

        assert hash1 == hash2
        assert hash1 != hash3
        assert len(hash1) == 32  # sha256 前 16 字节 = 32 hex 字符


class TestConcurrency:
    """并发测试"""

    @pytest.mark.anyio
    async def test_concurrent_search_429(self):
        """测试并发检索返回 429"""
        embedding_service._state = ModelState.READY
        retrieval_service._busy = True

        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://127.0.0.1:8001") as client:
            response = await client.post(
                "/retrieval/search",
                headers={"content-type": "application/json", "host": "127.0.0.1:8001"},
                json={
                    "query": "测试",
                    "topK": 5,
                    "minScore": 0.5,
                    "chunks": [{"id": "1", "content": "内容"}],
                },
            )

        assert response.status_code == 429
        data = response.json()
        assert data["error"]["code"] == "RETRIEVAL_BUSY"


class TestHostOriginCheck:
    """Host/Origin 检查测试"""

    @pytest.mark.anyio
    async def test_load_with_non_local_host(self):
        """测试非本地 Host"""
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                "/retrieval/load",
                headers={
                    "content-type": "application/json",
                    "host": "example.com",
                },
                content="{}",
            )

        assert response.status_code == 403
        data = response.json()
        assert data["error"]["code"] == "LOCAL_ACCESS_ONLY"


class TestBM25Scorer:
    """BM25 评分器测试"""

    def test_bigram_tokenization(self):
        """测试 bigram 分词"""
        from app.bm25 import tokenize_bigram

        assert tokenize_bigram("abc") == ["ab", "bc"]
        assert tokenize_bigram("中文") == ["中文"]
        assert tokenize_bigram("a") == ["a"]
        assert tokenize_bigram("") == []

    def test_build_index(self):
        """测试索引构建"""
        from app.bm25 import BM25Scorer

        scorer = BM25Scorer()
        scorer.build_index(["测试文档一", "测试文档二", "另一个文档"])

        assert scorer._num_docs == 3
        assert scorer._avg_doc_len > 0
        assert len(scorer._idf) > 0

    def test_build_index_empty(self):
        """测试空索引构建"""
        from app.bm25 import BM25Scorer

        scorer = BM25Scorer()
        scorer.build_index([])

        assert scorer._num_docs == 0
        assert scorer._avg_doc_len == 0.0
        assert len(scorer._idf) == 0

    def test_score_non_empty(self):
        """测试评分非零"""
        from app.bm25 import BM25Scorer, tokenize_bigram

        scorer = BM25Scorer()
        docs = ["机器学习是人工智能的子领域", "深度学习是机器学习的分支", "今天天气很好"]
        scorer.build_index(docs)

        score = scorer.score("机器学习", docs[0], len(tokenize_bigram(docs[0])))
        assert score > 0

    def test_score_empty_document(self):
        """测试空文档评分"""
        from app.bm25 import BM25Scorer

        scorer = BM25Scorer()
        scorer.build_index(["测试文档"])

        assert scorer.score("测试", "", 0) == 0.0

    def test_score_batch(self):
        """测试批量评分"""
        from app.bm25 import BM25Scorer

        scorer = BM25Scorer()
        docs = ["机器学习入门", "深度学习入门", "天气预报"]
        scorer.build_index(docs)

        scores = scorer.score_batch("机器学习", docs)
        assert len(scores) == 3
        assert scores[0] > 0  # “机器学习入门”应该匹配
        assert scores[2] == 0.0  # “天气预报”不应该匹配

    def test_score_unmatched_query(self):
        """测试不匹配的查询"""
        from app.bm25 import BM25Scorer

        scorer = BM25Scorer()
        docs = ["机器学习入门", "深度学习入门"]
        scorer.build_index(docs)

        scores = scorer.score_batch("量子计算", docs)
        assert all(s == 0.0 for s in scores)


class TestRRFFusion:
    """RRF 融合测试"""

    def test_single_vector_path(self):
        """测试单路向量检索退化"""
        # 当没有 BM25 结果时，应该直接使用向量结果
        vector_hits = [("a", 0.9), ("b", 0.8), ("c", 0.7)]
        # 在 retrieval.py 中，如果没有 bm25_hits，fused = vector_hits
        # 这里测试 _rrf_fusion 不会在单路时被调用
        # 但测试 RRF 本身在只有一路时的行为
        result = retrieval_service._rrf_fusion(vector_hits, [])
        # 只有向量路的贡献
        assert len(result) == 3
        assert result[0][0] == "a"

    def test_dual_path_fusion(self):
        """测试双路融合"""
        vector_hits = [("a", 0.9), ("b", 0.8)]
        bm25_hits = [("b", 5.0), ("c", 3.0)]

        result = retrieval_service._rrf_fusion(vector_hits, bm25_hits)
        ids = [cid for cid, _ in result]

        # "b" 在两路都出现，应该排名更高
        assert len(result) == 3
        assert "b" in ids
        assert "a" in ids
        assert "c" in ids

    def test_non_overlapping(self):
        """测试不重叠的融合"""
        vector_hits = [("a", 0.9), ("b", 0.8)]
        bm25_hits = [("c", 5.0), ("d", 3.0)]

        result = retrieval_service._rrf_fusion(vector_hits, bm25_hits)
        assert len(result) == 4

    def test_empty_inputs(self):
        """测试空输入"""
        result = retrieval_service._rrf_fusion([], [])
        assert result == []


class TestApplyFilters:
    """过滤器测试"""

    def test_no_filters(self):
        """测试无过滤"""
        from app.schemas import SearchRequest, ChunkInput

        chunks = [
            ChunkInput(id="1", content="内容1", knowledgeBaseId="kb1", documentType="txt"),
            ChunkInput(id="2", content="内容2", knowledgeBaseId="kb2", documentType="md"),
        ]
        request = SearchRequest(query="测试", topK=5, minScore=0.0, chunks=chunks)

        result = retrieval_service._apply_filters(chunks, request)
        assert len(result) == 2

    def test_knowledge_base_filter(self):
        """测试知识库过滤"""
        from app.schemas import SearchRequest, ChunkInput

        chunks = [
            ChunkInput(id="1", content="内容1", knowledgeBaseId="kb1"),
            ChunkInput(id="2", content="内容2", knowledgeBaseId="kb2"),
            ChunkInput(id="3", content="内容3", knowledgeBaseId="kb1"),
        ]
        request = SearchRequest(
            query="测试", topK=5, minScore=0.0, chunks=chunks,
            knowledgeBaseIds=["kb1"],
        )

        result = retrieval_service._apply_filters(chunks, request)
        assert len(result) == 2
        assert all(c.knowledgeBaseId == "kb1" for c in result)

    def test_document_type_filter(self):
        """测试文档类型过滤"""
        from app.schemas import SearchRequest, ChunkInput

        chunks = [
            ChunkInput(id="1", content="内容1", documentType="txt"),
            ChunkInput(id="2", content="内容2", documentType="md"),
            ChunkInput(id="3", content="内容3", documentType="pdf"),
        ]
        request = SearchRequest(
            query="测试", topK=5, minScore=0.0, chunks=chunks,
            documentTypes=["txt", "pdf"],
        )

        result = retrieval_service._apply_filters(chunks, request)
        assert len(result) == 2
        assert all(c.documentType in ("txt", "pdf") for c in result)

    def test_combined_filters(self):
        """测试组合过滤"""
        from app.schemas import SearchRequest, ChunkInput

        chunks = [
            ChunkInput(id="1", content="内容1", knowledgeBaseId="kb1", documentType="txt"),
            ChunkInput(id="2", content="内容2", knowledgeBaseId="kb1", documentType="md"),
            ChunkInput(id="3", content="内容3", knowledgeBaseId="kb2", documentType="txt"),
        ]
        request = SearchRequest(
            query="测试", topK=5, minScore=0.0, chunks=chunks,
            knowledgeBaseIds=["kb1"], documentTypes=["txt"],
        )

        result = retrieval_service._apply_filters(chunks, request)
        assert len(result) == 1
        assert result[0].id == "1"

    def test_filter_empty_result(self):
        """测试过滤后为空"""
        from app.schemas import SearchRequest, ChunkInput

        chunks = [
            ChunkInput(id="1", content="内容1", knowledgeBaseId="kb1"),
        ]
        request = SearchRequest(
            query="测试", topK=5, minScore=0.0, chunks=chunks,
            knowledgeBaseIds=["kb999"],
        )

        result = retrieval_service._apply_filters(chunks, request)
        assert len(result) == 0


class TestBM25Search:
    """BM25 检索集成测试"""

    def test_bm25_search_basic(self):
        """测试基本 BM25 检索"""
        from app.schemas import ChunkInput

        chunks = [
            ChunkInput(id="1", content="机器学习是人工智能的重要分支"),
            ChunkInput(id="2", content="深度学习在计算机视觉领域应用广泛"),
            ChunkInput(id="3", content="机器学习算法需要大量数据训练"),
        ]

        result = retrieval_service._bm25_search("机器学习", chunks)
        assert len(result) > 0
        # “机器学习”出现在 chunk 1 和 3 中
        ids = [cid for cid, _ in result]
        assert "1" in ids
        assert "3" in ids

    def test_bm25_search_no_match(self):
        """测试无匹配"""
        from app.schemas import ChunkInput

        chunks = [
            ChunkInput(id="1", content="今天天气很好"),
            ChunkInput(id="2", content="明天也不错"),
        ]

        result = retrieval_service._bm25_search("量子计算", chunks)
        assert len(result) == 0


class TestRerankerService:
    """Reranker 服务测试"""

    def test_initial_state(self):
        """测试初始状态"""
        assert reranker_service.state == RerankerState.UNLOADED
        assert reranker_service.error is None

    def test_health_unloaded(self):
        """测试未加载健康状态"""
        health = reranker_service.get_health()
        assert health["status"] == "unloaded"
        assert health["modelId"] == "BAAI/bge-reranker-v2-m3"

    def test_health_error(self):
        """测试错误健康状态"""
        reranker_service._state = RerankerState.ERROR
        reranker_service._error = "测试错误"

        health = reranker_service.get_health()
        assert health["status"] == "error"
        assert health["error"] == "测试错误"

    @pytest.mark.anyio
    async def test_load_triggers_background(self):
        """测试加载触发后台任务"""
        with patch.object(reranker_service, "_do_load", new_callable=AsyncMock) as mock_load:
            health = await reranker_service.load()
            assert health["status"] == "loading"

    @pytest.mark.anyio
    async def test_rerank_not_ready_raises(self):
        """测试未就绪时 rerank 抛出异常"""
        with pytest.raises(RuntimeError, match="Reranker 未就绪"):
            await reranker_service.rerank("query", ["passage"], top_k=1)

    @pytest.mark.anyio
    async def test_rerank_sync_mock(self):
        """测试同步 rerank（mock 模型）"""
        mock_model = MagicMock()
        mock_model.compute_score.return_value = [0.9, 0.3, 0.7]

        reranker_service._state = RerankerState.READY
        reranker_service._model = mock_model

        result = await reranker_service.rerank("查询", ["文档A", "文档B", "文档C"], top_k=2)

        assert len(result) == 2
        # 最高分应该是索引 0 (0.9)
        assert result[0][0] == 0
        assert result[0][1] == 0.9
        # 第二高应该是索引 2 (0.7)
        assert result[1][0] == 2
        assert result[1][1] == 0.7

    @pytest.mark.anyio
    async def test_rerank_single_passage(self):
        """测试单文档 rerank"""
        mock_model = MagicMock()
        mock_model.compute_score.return_value = 0.85

        reranker_service._state = RerankerState.READY
        reranker_service._model = mock_model

        result = await reranker_service.rerank("查询", ["唯一文档"], top_k=1)
        assert len(result) == 1
        assert result[0][0] == 0


class TestRerankerEndpoints:
    """Reranker 端点测试"""

    @pytest.mark.anyio
    async def test_reranker_health(self):
        """测试 reranker 健康检查端点"""
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/retrieval/reranker-health")

        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "unloaded"
        assert data["modelId"] == "BAAI/bge-reranker-v2-m3"

    @pytest.mark.anyio
    async def test_health_includes_reranker(self):
        """测试主健康检查包含 reranker 状态"""
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/retrieval/health")

        assert response.status_code == 200
        data = response.json()
        assert "reranker" in data["data"]
        assert data["data"]["reranker"]["status"] == "unloaded"

    @pytest.mark.anyio
    async def test_reranker_load_non_local(self):
        """测试 reranker 加载拒绝非本地请求"""
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                "/retrieval/reranker-load",
                headers={"host": "example.com"},
            )

        assert response.status_code == 403

    @pytest.mark.anyio
    async def test_load_with_non_local_origin(self):
        """测试非本地 Origin"""
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                "/retrieval/load",
                headers={
                    "content-type": "application/json",
                    "origin": "http://example.com",
                },
                content="{}",
            )

        assert response.status_code == 403
        data = response.json()
        assert data["error"]["code"] == "LOCAL_ACCESS_ONLY"
