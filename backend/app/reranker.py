"""Reranker 服务（BGE Reranker v2）- 优化版"""
import asyncio
import logging
from enum import Enum
from typing import List, Optional, Tuple

from . import config

logger = logging.getLogger(__name__)


class RerankerState(str, Enum):
    """Reranker 模型状态"""
    UNLOADED = "unloaded"
    LOADING = "loading"
    READY = "ready"
    ERROR = "error"


class RerankerTimeoutError(Exception):
    """Reranker 超时异常"""
    pass


class RerankerCancelledError(Exception):
    """Reranker 取消异常"""
    pass


class RerankerService:
    """重排序服务（优化版：支持超时、批处理、取消）"""

    def __init__(self):
        self._state: RerankerState = RerankerState.UNLOADED
        self._model = None
        self._error: Optional[str] = None
        self._lock = asyncio.Lock()
        self._current_task: Optional[asyncio.Task] = None

    @property
    def state(self) -> RerankerState:
        return self._state

    @property
    def error(self) -> Optional[str]:
        return self._error

    def get_health(self) -> dict:
        """获取健康状态"""
        result = {
            "status": self._state.value,
            "modelId": config.RERANKER_MODEL_ID,
        }
        if self._error:
            result["error"] = self._error
        return result

    async def load(self) -> dict:
        """加载模型（后台任务）"""
        async with self._lock:
            if self._state in (RerankerState.LOADING, RerankerState.READY):
                return self.get_health()

            self._state = RerankerState.LOADING
            self._error = None
            asyncio.create_task(self._do_load())
            return self.get_health()

    async def _do_load(self):
        """执行模型加载"""
        try:
            loop = asyncio.get_event_loop()
            model = await loop.run_in_executor(None, self._load_sync)
            self._model = model
            self._state = RerankerState.READY
            logger.info("Reranker 模型加载成功")
        except Exception as e:
            logger.exception("Reranker 加载失败")
            self._state = RerankerState.ERROR
            self._error = str(e)

    def _load_sync(self):
        """同步加载模型"""
        from FlagEmbedding import FlagReranker

        model_path = config.RERANKER_MODEL_PATH or config.RERANKER_MODEL_ID
        return FlagReranker(model_path, use_fp16=False, device="cpu")

    async def rerank(
        self,
        query: str,
        passages: List[str],
        top_k: int = 5,
        timeout: Optional[float] = None,
        cancel_token: Optional[asyncio.Event] = None,
    ) -> List[Tuple[int, float]]:
        """
        重排序，返回 [(原始索引, 分数), ...]
        
        Args:
            query: 查询文本
            passages: 候选文本列表
            top_k: 返回前 K 个结果
            timeout: 超时时间（秒），默认使用配置值
            cancel_token: 取消信号事件
        """
        if self._state != RerankerState.READY or self._model is None:
            raise RuntimeError("Reranker 未就绪")

        if not passages:
            return []

        timeout = timeout or config.RERANKER_TIMEOUT
        batch_size = config.RERANKER_BATCH_SIZE

        # 创建可取消的任务
        async def _run_rerank():
            loop = asyncio.get_event_loop()
            return await loop.run_in_executor(
                None,
                lambda: self._rerank_sync_batched(query, passages, top_k, batch_size, cancel_token)
            )

        try:
            # 使用 wait_for 添加超时
            result = await asyncio.wait_for(_run_rerank(), timeout=timeout)
            return result
        except asyncio.TimeoutError:
            logger.warning(f"Reranker 超时（{timeout}秒），已取消当前任务")
            self._cancel_current_task()
            raise RerankerTimeoutError(f"Reranker 执行超时（{timeout}秒）")
        except RerankerCancelledError:
            logger.info("Reranker 任务已取消")
            raise

    def _cancel_current_task(self):
        """取消当前正在执行的任务"""
        if self._current_task and not self._current_task.done():
            self._current_task.cancel()

    def _rerank_sync_batched(
        self,
        query: str,
        passages: List[str],
        top_k: int,
        batch_size: int,
        cancel_token: Optional[asyncio.Event] = None,
    ) -> List[Tuple[int, float]]:
        """
        同步批处理重排序（优化内存和 CPU 使用）
        
        Args:
            query: 查询文本
            passages: 候选文本列表
            top_k: 返回前 K 个结果
            batch_size: 批处理大小
            cancel_token: 取消信号
        """
        all_scores = []
        total = len(passages)

        # 分批处理，减少内存峰值
        for batch_start in range(0, total, batch_size):
            # 检查取消信号
            if cancel_token and cancel_token.is_set():
                raise RerankerCancelledError("任务已取消")

            batch_end = min(batch_start + batch_size, total)
            batch_passages = passages[batch_start:batch_end]

            # 构建批次对
            batch_pairs = [[query, p] for p in batch_passages]

            try:
                # 计算批次分数
                batch_scores = self._model.compute_score(batch_pairs, normalize=True)

                # 处理单值和多值返回
                if isinstance(batch_scores, (int, float)):
                    batch_scores = [batch_scores]

                all_scores.extend(batch_scores)
            except Exception as e:
                logger.error(f"Reranker 批次处理失败 (batch {batch_start}-{batch_end}): {e}")
                # 批次失败时，给该批次默认分数 0
                all_scores.extend([0.0] * len(batch_passages))

        # 排序并返回 top_k
        indexed = sorted(enumerate(all_scores), key=lambda x: x[1], reverse=True)
        return indexed[:top_k]


# 全局实例
reranker_service = RerankerService()
