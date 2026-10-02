"""Pure ranking helpers for schema retrieval: identifier tokenisation, BM25, cosine, rank fusion.

No database or network access here, so everything is unit-testable. `schema_index` wires these
to the stored table cards.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass, field

_STOP = {
    "the", "a", "an", "of", "in", "on", "for", "to", "and", "or", "by", "with", "from", "is", "are",
    "was", "were", "be", "that", "this", "it", "as", "at", "all", "any", "me", "my", "our", "we", "i",
    "you", "your", "do", "does", "did", "how", "what", "which", "who", "when", "where", "show", "list",
    "get", "give", "find", "please", "can", "could", "would", "should", "many", "much", "there", "each",
    "per", "than", "then", "into", "about", "top", "last", "first", "most", "least", "number", "count",
    "total", "sum", "average", "avg", "between", "have", "has", "had", "not", "no", "yes", "table",
    "tables", "column", "columns", "database", "data", "query", "sql", "select", "rows", "row",
}

_CAMEL = re.compile(r"(?<=[a-z0-9])(?=[A-Z])")
_WORD = re.compile(r"[A-Za-z0-9]+")


def singular(word: str) -> str:
    if len(word) > 4 and word.endswith("ies"):
        return word[:-3] + "y"
    if len(word) > 4 and word.endswith("ses"):
        return word[:-2]
    if len(word) > 3 and word.endswith("s") and not word.endswith("ss"):
        return word[:-1]
    return word


def tokenize(text: str) -> list[str]:
    """Split identifiers and prose into lowercase, singularised tokens: `orderItems` -> order, item."""
    tokens: list[str] = []
    for raw in _WORD.findall(_CAMEL.sub(" ", text.replace("_", " "))):
        word = raw.lower()
        if len(word) < 2 or word in _STOP or word.isdigit():
            continue
        tokens.append(singular(word))
    return tokens


@dataclass
class Document:
    key: str
    text: str
    terms: Counter[str] = field(default_factory=Counter)
    length: int = 0

    def __post_init__(self) -> None:
        if not self.terms:
            tokens = tokenize(self.text)
            self.terms = Counter(tokens)
            self.length = len(tokens)


class BM25:
    def __init__(self, documents: Iterable[Document], k1: float = 1.4, b: float = 0.6) -> None:
        self.docs = list(documents)
        self.k1, self.b = k1, b
        self.avg_len = (sum(d.length for d in self.docs) / len(self.docs)) if self.docs else 1.0
        df: Counter[str] = Counter()
        for doc in self.docs:
            df.update(doc.terms.keys())
        n = len(self.docs)
        self.idf = {term: math.log(1 + (n - count + 0.5) / (count + 0.5)) for term, count in df.items()}

    def score(self, query_terms: list[str], doc: Document) -> float:
        total = 0.0
        for term in query_terms:
            tf = doc.terms.get(term)
            if not tf:
                continue
            idf = self.idf.get(term, 0.0)
            denom = tf + self.k1 * (1 - self.b + self.b * doc.length / (self.avg_len or 1.0))
            total += idf * tf * (self.k1 + 1) / denom
        return total

    def rank(self, query: str, limit: int | None = None) -> list[tuple[str, float]]:
        terms = tokenize(query)
        scored = [(doc.key, self.score(terms, doc)) for doc in self.docs]
        scored = [(k, s) for k, s in scored if s > 0]
        scored.sort(key=lambda item: item[1], reverse=True)
        return scored[:limit] if limit else scored


def cosine(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


def reciprocal_rank_fusion(rankings: list[list[str]], k: int = 60) -> list[tuple[str, float]]:
    """Combine several ranked key lists; items near the top of any list win."""
    scores: dict[str, float] = {}
    for ranking in rankings:
        for position, key in enumerate(ranking):
            scores[key] = scores.get(key, 0.0) + 1.0 / (k + position + 1)
    return sorted(scores.items(), key=lambda item: item[1], reverse=True)


def mentioned_tables(text: str, table_names: Iterable[str]) -> list[str]:
    """Tables whose (unqualified) name, or its singular/plural, appears as a word in the text."""
    words = {w.lower() for w in _WORD.findall(text.replace("_", " "))}
    words |= {singular(w) for w in words}
    found = []
    for name in table_names:
        bare = name.split(".")[-1].lower()
        candidates = {bare, singular(bare), bare.replace("_", " ")}
        parts = [p for p in bare.split("_") if p]
        if bare in words or singular(bare) in words:
            found.append(name)
        elif len(parts) > 1 and all((p in words or singular(p) in words) for p in parts):
            found.append(name)
        elif any(c in text.lower() for c in candidates if " " in c):
            found.append(name)
    return found
