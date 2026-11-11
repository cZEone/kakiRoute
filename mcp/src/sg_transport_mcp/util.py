"""Small shared helpers: Singapore time, distances, caching, sorting."""

from __future__ import annotations

import math
import re
import time
from datetime import datetime, timedelta, timezone
from typing import Any

SGT = timezone(timedelta(hours=8), "SGT")


def now_sgt() -> datetime:
    return datetime.now(SGT)


def parse_dt(value: str | None) -> datetime | None:
    """Parse an ISO-8601 timestamp; naive values are assumed to be SGT."""
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=SGT)


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6_371_000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def natural_key(text: str) -> list[Any]:
    """Sort '2', '10', '10e', '107M' the way people expect."""
    return [int(tok) if tok.isdigit() else tok.lower() for tok in re.split(r"(\d+)", str(text))]


def matches_all_words(query: str, *fields: Any) -> bool:
    haystack = " ".join(str(f) for f in fields if f).lower()
    return all(word in haystack for word in query.lower().split())


def to_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


class TTLCache:
    """Tiny in-memory cache with per-entry expiry."""

    def __init__(self) -> None:
        self._data: dict[Any, tuple[float, Any]] = {}

    def get(self, key: Any) -> Any | None:
        hit = self._data.get(key)
        if hit is None:
            return None
        expires, value = hit
        if expires < time.monotonic():
            self._data.pop(key, None)
            return None
        return value

    def set(self, key: Any, value: Any, ttl: float) -> None:
        self._data[key] = (time.monotonic() + ttl, value)
