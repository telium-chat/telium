"""JSON-over-HTTP with bounded 429 retries and a per-attempt timeout."""

from __future__ import annotations

import asyncio
import json
import time
from email.utils import parsedate_to_datetime
from typing import Any

import aiohttp

from .errors import HttpError, RequestTimeout

MAX_RETRY_DELAY_S = 16.0
DEFAULT_TIMEOUT_S = 15.0


def _bounded(seconds: float) -> float:
    return min(MAX_RETRY_DELAY_S, max(0.25, seconds))


def _retry_delay(headers: Any, payload: Any, attempt: int) -> float:
    raw = payload.get("retry_after") if isinstance(payload, dict) else None
    if raw is None:
        raw = headers.get("retry-after")
    try:
        numeric = float(raw)
        if numeric >= 0:
            return _bounded(numeric)
    except (TypeError, ValueError):
        if isinstance(raw, str):
            try:
                at = parsedate_to_datetime(raw).timestamp()
                return _bounded(at - time.time())
            except (TypeError, ValueError):
                pass
    return min(MAX_RETRY_DELAY_S, float(2**attempt))


async def request(
    session: aiohttp.ClientSession,
    base: str,
    method: str,
    path: str,
    *,
    bearer: str | None = None,
    bot_token: str | None = None,
    body: Any = None,
    retry429: int | bool = 5,
    timeout: float | None = DEFAULT_TIMEOUT_S,
) -> Any:
    if bearer and bot_token:
        raise ValueError(
            "request() was given both bearer and bot_token; refusing to guess which Authorization "
            "to send. The long-lived bot token goes only to the bot home."
        )
    headers: dict[str, str] = {}
    if bearer:
        headers["Authorization"] = f"Bearer {bearer}"
    if bot_token:
        headers["Authorization"] = f"Bot {bot_token}"
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body)

    if retry429 is True:
        retries = 5
    elif retry429 is False:
        retries = 0
    else:
        retries = max(0, min(8, int(retry429 or 0)))
    per_attempt = DEFAULT_TIMEOUT_S if timeout is None else float(timeout)

    url = base.rstrip("/") + path
    attempt = 0
    while True:
        try:
            async with session.request(
                method,
                url,
                headers=headers,
                data=data,
                allow_redirects=False,
                timeout=aiohttp.ClientTimeout(total=per_attempt),
            ) as response:
                raw = await response.read()
                status = response.status
                response_headers = response.headers
        except asyncio.TimeoutError as exc:
            raise RequestTimeout(f"{method} {url} timed out after {per_attempt}s") from exc

        try:
            payload = json.loads(raw) if raw else None
        except ValueError:
            payload = None

        if status == 429 and attempt < retries:
            await asyncio.sleep(_retry_delay(response_headers, payload, attempt))
            attempt += 1
            continue
        if status >= 400:
            message = payload.get("message") if isinstance(payload, dict) else None
            raise HttpError(message or f"HTTP {status}", status=status, body=payload)
        return payload
