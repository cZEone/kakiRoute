"""data.gov.sg real-time weather APIs (NEA / Meteorological Service Singapore)."""

from __future__ import annotations

from typing import Any

import httpx
from mcp.server.mcpserver.exceptions import ToolError

from .util import TTLCache

DATAGOV_BASE_URL = "https://api-open.data.gov.sg/v2/real-time/api/"


class WeatherClient:
    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str = DATAGOV_BASE_URL,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        headers = {"accept": "application/json"}
        if api_key and api_key.strip():
            headers["x-api-key"] = api_key.strip()
        self._http = httpx.AsyncClient(base_url=base_url, timeout=30.0, transport=transport, headers=headers)
        self._cache = TTLCache()

    async def aclose(self) -> None:
        await self._http.aclose()

    async def get(self, endpoint: str, *, ttl: float = 60) -> dict[str, Any]:
        if (cached := self._cache.get(endpoint)) is not None:
            return cached
        try:
            resp = await self._http.get(endpoint)
        except httpx.HTTPError as exc:
            raise ToolError(f"Could not reach data.gov.sg ({endpoint}): {exc.__class__.__name__}") from exc
        if resp.status_code == 429:
            raise ToolError(
                "data.gov.sg rate limit hit (HTTP 429). Set DATA_GOV_SG_API_KEY for higher limits "
                "(free at https://data.gov.sg/signin)."
            )
        if resp.status_code >= 400:
            raise ToolError(f"data.gov.sg returned HTTP {resp.status_code} for {endpoint}.")
        try:
            body = resp.json()
        except ValueError as exc:
            raise ToolError(f"data.gov.sg sent a non-JSON response for {endpoint}.") from exc
        if body.get("code") not in (0, None):
            raise ToolError(f"data.gov.sg error for {endpoint}: {body.get('errorMsg') or body.get('code')}")
        data = body.get("data") or {}
        self._cache.set(endpoint, data, ttl)
        return data
