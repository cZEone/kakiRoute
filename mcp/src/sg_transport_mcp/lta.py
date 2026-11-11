"""LTA DataMall client (https://datamall.lta.gov.sg), API User Guide v6.11 (30 Oct 2026)."""

from __future__ import annotations

import asyncio
from typing import Any
from urllib.parse import urlencode

import httpx
from mcp.server.mcpserver.exceptions import ToolError

from .util import TTLCache

LTA_BASE_URL = "https://datamall2.mytransport.sg/ltaodataservice/"
MAX_PAGES = 400  # safety stop for paginated datasets (400 x 500 = 200k rows)

MISSING_KEY_MESSAGE = (
    "LTA_ACCOUNT_KEY is not set. Request a free AccountKey at "
    "https://datamall.lta.gov.sg/content/datamall/en/request-for-api.html and add it to this "
    "MCP server's environment."
)


class LTAClient:
    """Thin async wrapper over LTA DataMall with caching and $skip pagination."""

    def __init__(
        self,
        account_key: str | None,
        *,
        base_url: str = LTA_BASE_URL,
        transport: httpx.AsyncBaseTransport | None = None,
        download_transport: httpx.AsyncBaseTransport | None = None,
        page_concurrency: int = 5,
    ) -> None:
        self._key = (account_key or "").strip() or None
        self._http = httpx.AsyncClient(
            base_url=base_url, timeout=30.0, transport=transport, headers={"accept": "application/json"}
        )
        # Separate client for pre-signed S3 links, so the AccountKey never leaves LTA's host.
        self._download = httpx.AsyncClient(timeout=120.0, transport=download_transport, follow_redirects=True)
        self._cache = TTLCache()
        self._locks: dict[Any, asyncio.Lock] = {}
        self._page_concurrency = max(1, page_concurrency)

    async def aclose(self) -> None:
        await self._http.aclose()
        await self._download.aclose()

    def _lock(self, key: Any) -> asyncio.Lock:
        return self._locks.setdefault(key, asyncio.Lock())

    async def get(self, path: str, params: dict[str, Any] | None = None, *, ttl: float = 0) -> dict[str, Any]:
        """GET one DataMall resource and return its JSON body ({} when the body is empty)."""
        if not self._key:
            raise ToolError(MISSING_KEY_MESSAGE)
        clean = {k: v for k, v in (params or {}).items() if v not in (None, "")}
        # Keep "$skip" literal: DataMall documents it unencoded.
        url = path + ("?" + urlencode(clean, safe="$") if clean else "")
        if ttl and (cached := self._cache.get(url)) is not None:
            return cached
        try:
            resp = await self._http.get(url, headers={"AccountKey": self._key})
        except httpx.HTTPError as exc:
            raise ToolError(f"Could not reach LTA DataMall ({path}): {exc.__class__.__name__}") from exc
        if resp.status_code in (401, 403):
            raise ToolError("LTA DataMall rejected the AccountKey (HTTP %d). Check LTA_ACCOUNT_KEY." % resp.status_code)
        if resp.status_code == 429:
            raise ToolError("LTA DataMall rate limit hit (HTTP 429). Try again shortly.")
        if resp.status_code >= 400:
            raise ToolError(f"LTA DataMall returned HTTP {resp.status_code} for {path}.")
        if not resp.content.strip():
            data: dict[str, Any] = {}
        else:
            try:
                data = resp.json()
            except ValueError as exc:
                raise ToolError(f"LTA DataMall sent a non-JSON response for {path}.") from exc
        if ttl:
            self._cache.set(url, data, ttl)
        return data

    async def get_all(self, path: str, params: dict[str, Any] | None = None, *, ttl: float = 0) -> list[dict[str, Any]]:
        """Fetch every page of a paginated dataset (DataMall returns <=500 rows per call)."""
        cache_key = ("all", path, tuple(sorted((params or {}).items())))
        if ttl and (cached := self._cache.get(cache_key)) is not None:
            return cached
        async with self._lock(cache_key):
            if ttl and (cached := self._cache.get(cache_key)) is not None:
                return cached
            first = _rows(await self.get(path, params))
            rows = list(first)
            page_size = len(first)
            skip = page_size
            pages = 1
            # Page size is learned from page 1 (LTA says it "may be adjusted from time to time").
            while page_size and pages < MAX_PAGES:
                skips = [skip + i * page_size for i in range(self._page_concurrency)]
                results = await asyncio.gather(*(self.get(path, {**(params or {}), "$skip": s}) for s in skips))
                finished = False
                for body in results:
                    batch = _rows(body)
                    rows.extend(batch)
                    pages += 1
                    if len(batch) < page_size:
                        finished = True
                        break
                if finished:
                    break
                skip += page_size * self._page_concurrency
            if ttl:
                self._cache.set(cache_key, rows, ttl)
            return rows

    async def download_link(self, path: str, *, ttl: float = 0) -> bytes:
        """For datasets that return a short-lived download Link (GTFS feeds), fetch the file bytes."""
        cache_key = ("file", path)
        if ttl and (cached := self._cache.get(cache_key)) is not None:
            return cached
        async with self._lock(cache_key):
            if ttl and (cached := self._cache.get(cache_key)) is not None:
                return cached
            link = find_link(await self.get(path))
            if not link:
                raise ToolError(f"LTA DataMall returned no download link for {path}.")
            try:
                resp = await self._download.get(link)
                resp.raise_for_status()
            except httpx.HTTPError as exc:
                raise ToolError(f"Could not download the {path} file: {exc.__class__.__name__}") from exc
            if ttl:
                self._cache.set(cache_key, resp.content, ttl)
            return resp.content


def _rows(body: dict[str, Any]) -> list[dict[str, Any]]:
    value = body.get("value", [])
    if isinstance(value, dict):
        return [value]
    return list(value or [])


def find_link(body: Any) -> str | None:
    """Locate the 'Link' attribute wherever DataMall nests it."""
    if isinstance(body, dict):
        for key, val in body.items():
            if key.lower() == "link" and isinstance(val, str) and val.startswith("http"):
                return val
        for val in body.values():
            if (found := find_link(val)) is not None:
                return found
    elif isinstance(body, list):
        for item in body:
            if (found := find_link(item)) is not None:
                return found
    return None
