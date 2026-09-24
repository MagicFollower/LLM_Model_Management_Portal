"""模型生命周期管理与编码"""
import asyncio
import logging
from typing import Optional, List
from enum import Enum

import numpy as np
from sentence_transformers import SentenceTransformer

from . import config

logger = logging.getLogger(__name__)


class ModelState(str, Enum):
    """模型状态"""
    UNLOADED = "unloaded"
    LOADING = "loading"
    READY = "ready"
    ERROR = "error"


class EmbeddingService:
    """嵌入服务"""

    def __init__(self):
        self._state: ModelState = ModelState.UNLOADED
        self._model: Optional[SentenceTransformer] = None
        self._error: Optional[str] = None
        self._load_task: Optional[asyncio.Task] = None
        self._lock = asyncio.Lock()

    @property
    def state(self) -> ModelState:
        return self._state

    @property
    def error(self) -> Optional[str]:
        return self._error

    def get_health(self) -> dict:
        """获取健康状态"""
        result = {
            "status": self._state.value,
            "modelId": config.MODEL_ID,
            "dimension": config.DIMENSION,
            "device": "cpu",
        }
        if self._error:
            result["error"] = self._error
        return result

    async def load(self) -> dict:
        """加载模型（后台任务）"""
        async with self._lock:
            if self._state == ModelState.LOADING:
                return self.get_health()

            if self._state == ModelState.READY:
                return self.get_health()

            self._state = ModelState.LOADING
            self._error = None
            self._load_task = asyncio.create_task(self._do_load())
            return self.get_health()

    async def _do_load(self):
        """执行模型加载"""
        try:
            loop = asyncio.get_event_loop()
            model = await loop.run_in_executor(None, self._load_model_sync)

            # 先赋值，再验证（_encode_sync 依赖 self._model）
            self._model = model

            test_vec = self._encode_sync("测试")
            if test_vec.shape[0] != config.DIMENSION:
                raise ValueError(f"模型维度错误: {test_vec.shape[0]} != {config.DIMENSION}")
            if not np.isfinite(test_vec).all():
                raise ValueError("模型输出包含非有限值")
            if np.linalg.norm(test_vec) < 1e-6:
                raise ValueError("模型输出为零向量")

            self._state = ModelState.READY
            logger.info("模型加载成功")
        except Exception as e:
            logger.exception("模型加载失败")
            self._state = ModelState.ERROR
            self._error = str(e)

    def _load_model_sync(self) -> SentenceTransformer:
        """同步加载模型"""
        model_path = config.MODEL_PATH if config.MODEL_PATH else config.MODEL_ID
        return SentenceTransformer(
            model_path,
            cache_folder=config.CACHE_DIR,
            device="cpu",
        )

    async def encode(self, texts: List[str], is_query: bool = False) -> np.ndarray:
        """编码文本"""
        if self._state != ModelState.READY or self._model is None:
            raise RuntimeError("模型未加载")

        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(
            None, lambda: self._encode_batch_sync(texts, is_query)
        )

    def _encode_batch_sync(self, texts: List[str], is_query: bool) -> np.ndarray:
        """批量编码（同步）"""
        if not texts:
            return np.zeros((0, config.DIMENSION), dtype=np.float32)

        results = []
        for text in texts:
            vec = self._encode_sync(text, is_query)
            results.append(vec)

        return np.stack(results, axis=0)

    def _encode_sync(self, text: str, is_query: bool = False) -> np.ndarray:
        """同步编码单个文本（支持长文本窗口切分）"""
        if self._model is None:
            raise RuntimeError("模型未加载")

        # 查询加前缀
        if is_query:
            text = config.QUERY_PREFIX + text

        # 获取 tokenizer
        tokenizer = self._model.tokenizer
        model = self._model[0].auto_model

        # 不截断 tokenize，获取真实 token 长度
        encoding = tokenizer(
            text,
            add_special_tokens=True,
            return_tensors="np",
            truncation=False,
        )
        input_ids = encoding["input_ids"][0]
        token_len = len(input_ids)

        # 模型窗口（减去 [CLS] 和 [SEP]）
        max_length = getattr(model.config, "max_position_embeddings", 512)
        window_size = max_length - 2

        if token_len <= window_size:
            # 直接编码
            return self._encode_single(text)

        # 长文本窗口切分
        overlap = 32
        stride = window_size - overlap
        windows = []

        for start in range(0, token_len, stride):
            end = min(start + window_size, token_len)
            window_ids = input_ids[start:end]
            windows.append(window_ids)

            if end == token_len:
                break

        # 对每个窗口编码并平均
        embeddings = []
        for window_ids in windows:
            vec = self._encode_ids(window_ids)
            embeddings.append(vec)

        # 平均池化
        avg = np.mean(embeddings, axis=0)
        # L2 归一化
        norm = np.linalg.norm(avg)
        if norm > 1e-8:
            avg = avg / norm

        return avg

    def _encode_ids(self, input_ids: np.ndarray) -> np.ndarray:
        """编码 token IDs"""
        import torch

        if self._model is None:
            raise RuntimeError("模型未加载")

        model = self._model[0].auto_model

        with torch.no_grad():
            inputs = torch.tensor(input_ids).unsqueeze(0)
            outputs = model(inputs)
            # CLS pooling
            embedding = outputs[0][:, 0].squeeze(0).numpy()

        # L2 归一化
        norm = np.linalg.norm(embedding)
        if norm > 1e-8:
            embedding = embedding / norm

        return embedding

    def _encode_single(self, text: str) -> np.ndarray:
        """编码单个短文本"""
        if self._model is None:
            raise RuntimeError("模型未加载")

        result = self._model.encode(
            text,
            normalize_embeddings=True,
            convert_to_numpy=True,
        )
        return result


# 全局实例
embedding_service = EmbeddingService()
