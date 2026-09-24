"""检索服务测试"""
import asyncio
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
import numpy as np

from httpx import AsyncClient, ASGITransport

from app.main import app
from app.embedding import embedding_service, ModelState
from app.retrieval import retrieval_service, _content_hash


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
