"""BM25 关键词检索（字符 bigram 适配中文）"""
import math
from collections import Counter, defaultdict
from typing import List


def tokenize_bigram(text: str) -> List[str]:
    """字符 bigram 分词（适配中文，零外部依赖）"""
    chars = list(text.strip())
    if len(chars) < 2:
        return chars
    return [chars[i] + chars[i + 1] for i in range(len(chars) - 1)]


class BM25Scorer:
    """BM25 Okapi 评分器"""

    def __init__(self, k1: float = 1.5, b: float = 0.75):
        self.k1 = k1
        self.b = b
        self._idf: dict = {}
        self._avg_doc_len = 0.0
        self._num_docs = 0

    def build_index(self, documents: List[str]) -> None:
        """构建倒排索引"""
        self._num_docs = len(documents)
        if not documents:
            return

        term_doc_freq: dict = defaultdict(set)
        total_len = 0

        for doc_id, doc in enumerate(documents):
            tokens = tokenize_bigram(doc)
            total_len += len(tokens)
            for token in set(tokens):
                term_doc_freq[token].add(doc_id)

        self._avg_doc_len = total_len / self._num_docs if self._num_docs else 0.0

        # BM25 IDF 变体
        self._idf = {}
        for term, doc_ids in term_doc_freq.items():
            df = len(doc_ids)
            self._idf[term] = math.log((self._num_docs - df + 0.5) / (df + 0.5) + 1.0)

    def score(self, query: str, document: str, doc_len: int) -> float:
        """计算单个文档的 BM25 分数"""
        if not self._idf or not document:
            return 0.0

        query_tokens = tokenize_bigram(query)
        doc_tokens = Counter(tokenize_bigram(document))

        score = 0.0
        for token in query_tokens:
            idf = self._idf.get(token, 0.0)
            if idf == 0.0:
                continue
            tf = doc_tokens.get(token, 0)
            numerator = tf * (self.k1 + 1)
            denominator = tf + self.k1 * (
                1 - self.b + self.b * (doc_len / self._avg_doc_len)
                if self._avg_doc_len > 0
                else 1
            )
            score += idf * (numerator / denominator)

        return score

    def score_batch(self, query: str, documents: List[str]) -> List[float]:
        """批量评分"""
        return [
            self.score(query, doc, len(tokenize_bigram(doc)))
            for doc in documents
        ]
