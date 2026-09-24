"""FastAPI 应用"""
import json
import logging
from typing import Callable

from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware

from . import config
from .schemas import (
    HealthResponse,
    HealthData,
    SearchRequest,
    SearchResponse,
    ErrorEnvelope,
    ErrorDetail,
)
from .embedding import embedding_service, ModelState
from .retrieval import retrieval_service
from .reranker import reranker_service, RerankerState

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

# 创建应用
app = FastAPI(title="Knowledge Retrieval Service", version="1.0.0")

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


def error_response(status: int, code: str, message: str) -> JSONResponse:
    """构造错误响应"""
    return JSONResponse(
        status_code=status,
        content=ErrorEnvelope(error=ErrorDetail(code=code, message=message)).model_dump(),
    )


def check_local_access(request: Request) -> bool:
    """检查是否来自 localhost"""
    host = request.headers.get("host", "")
    origin = request.headers.get("origin", "")

    # 检查 host
    if host:
        host_lower = host.lower()
        if not (
            host_lower.startswith("localhost")
            or host_lower.startswith("127.0.0.1")
            or host_lower.startswith("[::1]")
        ):
            return False

    # 检查 origin
    if origin:
        origin_lower = origin.lower()
        if not (
            "localhost" in origin_lower
            or "127.0.0.1" in origin_lower
        ):
            return False

    return True


@app.middleware("http")
async def check_body_size(request: Request, call_next: Callable):
    """检查请求体大小"""
    if request.method in ("POST", "PUT", "PATCH"):
        content_length = request.headers.get("content-length")
        if content_length and int(content_length) > config.MAX_REQUEST_BYTES:
            return error_response(413, "REQUEST_TOO_LARGE", "请求体过大")

    return await call_next(request)


@app.get("/retrieval/health")
async def health():
    """健康检查"""
    health_data = embedding_service.get_health()
    response = HealthResponse(data=HealthData(**health_data))
    result = response.model_dump()
    # 追加 reranker 状态（可选字段）
    reranker_health = reranker_service.get_health()
    result["data"]["reranker"] = reranker_health
    return result


@app.post("/retrieval/load")
async def load_model(request: Request):
    """加载模型"""
    # 检查本地访问
    if not check_local_access(request):
        return error_response(403, "LOCAL_ACCESS_ONLY", "仅允许本地访问")

    # 检查 Content-Type
    content_type = request.headers.get("content-type", "")
    if content_type and "application/json" not in content_type:
        return error_response(415, "UNSUPPORTED_MEDIA_TYPE", "不支持的媒体类型")

    # 读取并验证 body
    try:
        body = await request.body()
        if len(body) > config.MAX_REQUEST_BYTES:
            return error_response(413, "REQUEST_TOO_LARGE", "请求体过大")

        if body:
            try:
                json.loads(body)
            except json.JSONDecodeError:
                return error_response(400, "INVALID_JSON", "无效的 JSON")
    except Exception:
        return error_response(400, "INVALID_JSON", "读取请求体失败")

    # 根据状态处理
    state = embedding_service.state
    if state == ModelState.READY:
        health_data = embedding_service.get_health()
        resp = HealthResponse(data=HealthData(**health_data)).model_dump()
        resp["data"]["reranker"] = reranker_service.get_health()
        return resp

    if state == ModelState.LOADING:
        health_data = embedding_service.get_health()
        resp = HealthResponse(data=HealthData(**health_data)).model_dump()
        resp["data"]["reranker"] = reranker_service.get_health()
        return resp

    # unloaded 或 error，启动加载
    await embedding_service.load()

    # 如果 Reranker 已启用，同时触发加载
    if config.RERANKER_ENABLED and reranker_service.state == RerankerState.UNLOADED:
        await reranker_service.load()

    health_data = embedding_service.get_health()
    resp = HealthResponse(data=HealthData(**health_data)).model_dump()
    resp["data"]["reranker"] = reranker_service.get_health()
    return JSONResponse(
        status_code=202,
        content=resp,
    )


@app.post("/retrieval/search")
async def search(request: Request):
    """检索"""
    # 检查本地访问
    if not check_local_access(request):
        return error_response(403, "LOCAL_ACCESS_ONLY", "仅允许本地访问")

    # 检查 Content-Type
    content_type = request.headers.get("content-type", "")
    if "application/json" not in content_type:
        return error_response(415, "UNSUPPORTED_MEDIA_TYPE", "不支持的媒体类型")

    # 检查模型状态
    if embedding_service.state != ModelState.READY:
        if embedding_service.state == ModelState.LOADING:
            return error_response(503, "MODEL_LOADING", "模型加载中")
        elif embedding_service.state == ModelState.ERROR:
            return error_response(503, "MODEL_LOAD_FAILED", "模型加载失败")
        else:
            return error_response(503, "MODEL_NOT_LOADED", "模型未加载")

    # 检查繁忙
    if retrieval_service.is_busy:
        return error_response(429, "RETRIEVAL_BUSY", "服务繁忙")

    # 读取 body
    try:
        body = await request.body()
        if len(body) > config.MAX_REQUEST_BYTES:
            return error_response(413, "REQUEST_TOO_LARGE", "请求体过大")
    except Exception:
        return error_response(400, "INVALID_JSON", "读取请求体失败")

    # 解析 JSON
    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        return error_response(400, "INVALID_JSON", "无效的 JSON")

    # 验证请求
    try:
        req = SearchRequest(**data)
    except ValueError as e:
        return error_response(422, "VALIDATION_ERROR", str(e))
    except Exception as e:
        return error_response(422, "VALIDATION_ERROR", f"参数验证失败: {e}")

    # 额外验证
    # query 非空
    if not req.query or not req.query.strip():
        return error_response(422, "VALIDATION_ERROR", "query 不能为空")

    # query 长度
    if len(req.query) > config.MAX_QUERY_LENGTH:
        return error_response(422, "VALIDATION_ERROR", f"query 长度超过 {config.MAX_QUERY_LENGTH}")

    # topK
    if not isinstance(req.topK, int) or req.topK < 1 or req.topK > 20:
        return error_response(422, "VALIDATION_ERROR", "topK 必须是 1-20 的整数")

    # minScore
    import math
    if not math.isfinite(req.minScore) or req.minScore < -1 or req.minScore > 1:
        return error_response(422, "VALIDATION_ERROR", "minScore 必须是有限数且在 [-1, 1] 范围内")

    # chunks 验证
    if len(req.chunks) > config.MAX_CHUNKS:
        return error_response(413, "CANDIDATE_LIMIT_EXCEEDED", f"chunks 数量超过 {config.MAX_CHUNKS}")

    total_content = 0
    chunk_ids = set()
    for chunk in req.chunks:
        if not chunk.id or not chunk.id.strip():
            return error_response(422, "VALIDATION_ERROR", "chunk ID 不能为空")

        if chunk.id in chunk_ids:
            return error_response(422, "VALIDATION_ERROR", "chunk ID 重复")
        chunk_ids.add(chunk.id)

        if not chunk.content or not chunk.content.strip():
            return error_response(422, "VALIDATION_ERROR", "chunk content 不能为空")

        if len(chunk.content) > config.MAX_CHUNK_CONTENT:
            return error_response(413, "CANDIDATE_LIMIT_EXCEEDED", f"chunk content 长度超过 {config.MAX_CHUNK_CONTENT}")

        total_content += len(chunk.content)

    if total_content > config.MAX_TOTAL_CONTENT:
        return error_response(413, "CANDIDATE_LIMIT_EXCEEDED", f"总 content 长度超过 {config.MAX_TOTAL_CONTENT}")

    # 执行检索
    try:
        result = await retrieval_service.search(req)
        return SearchResponse(data=result)
    except RuntimeError as e:
        if "RETRIEVAL_BUSY" in str(e):
            return error_response(429, "RETRIEVAL_BUSY", "服务繁忙")
        logger.exception("检索失败")
        return error_response(500, "ENCODING_FAILED", "编码失败")
    except Exception as e:
        logger.exception("检索失败")
        return error_response(500, "ENCODING_FAILED", f"检索失败: {e}")


@app.get("/retrieval/reranker-health")
async def reranker_health():
    """Reranker 健康检查"""
    return reranker_service.get_health()


@app.post("/retrieval/reranker-load")
async def reranker_load(request: Request):
    """加载 Reranker 模型"""
    if not check_local_access(request):
        return error_response(403, "LOCAL_ACCESS_ONLY", "仅允许本地访问")

    health = await reranker_service.load()
    status_code = 200 if reranker_service.state == RerankerState.READY else 202
    return JSONResponse(status_code=status_code, content=health)


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    """全局异常处理"""
    logger.exception("未处理的异常")
    return error_response(500, "INTERNAL_ERROR", "内部服务器错误")
