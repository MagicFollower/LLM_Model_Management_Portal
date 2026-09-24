"""Pydantic v2 数据模型"""
from typing import Generic, TypeVar, Optional, List
from pydantic import BaseModel, Field

T = TypeVar("T")


class Envelope(BaseModel, Generic[T]):
    """成功响应信封"""
    data: T


class ErrorDetail(BaseModel):
    """错误详情"""
    code: str
    message: str


class ErrorEnvelope(BaseModel):
    """错误响应信封"""
    error: ErrorDetail


class HealthData(BaseModel):
    """健康检查数据"""
    status: str = Field(..., pattern="^(unloaded|loading|ready|error)$")
    modelId: str
    dimension: int = 512
    device: str = "cpu"
    error: Optional[str] = None


class HealthResponse(BaseModel):
    """健康检查响应"""
    data: HealthData


class ChunkInput(BaseModel):
    """输入文档块"""
    id: str
    content: str
    knowledgeBaseId: Optional[str] = None
    documentType: Optional[str] = None


class SearchRequest(BaseModel):
    """检索请求"""
    query: str
    topK: int = Field(..., ge=1, le=20)
    minScore: float = Field(..., ge=-1.0, le=1.0)
    chunks: List[ChunkInput]
    enableBm25: Optional[bool] = False
    enableRerank: Optional[bool] = False
    knowledgeBaseIds: Optional[List[str]] = None
    documentTypes: Optional[List[str]] = None


class SearchHit(BaseModel):
    """检索结果"""
    id: str
    score: float
    vectorScore: Optional[float] = None
    bm25Score: Optional[float] = None
    rerankScore: Optional[float] = None


class SearchResponseData(BaseModel):
    """检索响应数据"""
    hits: List[SearchHit]
    modelId: str
    dimension: int = 512
    elapsedMs: float
    totalChunks: int
    rerankerUsed: Optional[bool] = False


class SearchResponse(BaseModel):
    """检索响应"""
    data: SearchResponseData
