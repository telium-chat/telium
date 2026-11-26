"""One gateway websocket per guild server, with heartbeat liveness and backoff reconnects."""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any, Awaitable, Callable

import aiohttp

DEFAULT_HEARTBEAT_ACK_TIMEOUT_S = 15.0
# A connection must survive this long before backoff resets.
DEFAULT_STABLE_AFTER_S = 30.0


class GatewayConnection:
    def __init__(
        self,
        *,
        domain: str,
        gateway: str,
        token: str,
        intents: list[str],
        session: aiohttp.ClientSession,
        refresh: Callable[[], Awaitable[dict]],
        on_dispatch: Callable[[str | None, Any], None] | None = None,
        on_ready: Callable[[Any], None] | None = None,
        on_error: Callable[[BaseException], None] | None = None,
        on_refresh_error: Callable[[BaseException, int], bool | None] | None = None,
        on_stopped: Callable[[], None] | None = None,
        on_heartbeat_timeout: Callable[[BaseException], None] | None = None,
        retry_base_s: float = 0.5,
        retry_max_s: float = 30.0,
        heartbeat_ack_timeout_s: float = DEFAULT_HEARTBEAT_ACK_TIMEOUT_S,
        stable_after_s: float = DEFAULT_STABLE_AFTER_S,
    ):
        self.domain = domain
        self.gateway = gateway
        self.token = token
        self.intents = intents
        self.session = session
        self.refresh = refresh
        self.on_dispatch = on_dispatch
        self.on_ready = on_ready
        self.on_error = on_error
        self.on_refresh_error = on_refresh_error
        self.on_stopped = on_stopped
        self.on_heartbeat_timeout = on_heartbeat_timeout
        self.retry_base_s = retry_base_s
        self.retry_max_s = retry_max_s
        self.heartbeat_ack_timeout_s = max(0.25, heartbeat_ack_timeout_s)
        self.stable_after_s = max(0.0, stable_after_s)
        self.closed = False
        self.attempt = 0
        self._task: asyncio.Task | None = None
        self._ws: aiohttp.ClientWebSocketResponse | None = None
        self._ready_at: float | None = None

    def open(self) -> None:
        if self.closed or self._task is not None:
            return
        self._task = asyncio.create_task(self._run(), name=f"telium-gateway-{self.domain}")

    async def close(self) -> None:
        self.closed = True
        ws, self._ws = self._ws, None
        if ws is not None and not ws.closed:
            await ws.close()
        task, self._task = self._task, None
        if task is not None and task is not asyncio.current_task():
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass

    def _report(self, error: BaseException) -> None:
        if self.on_error:
            self.on_error(error)

    async def _run(self) -> None:
        """Connect, serve, and reconnect with backoff until closed or told to stop."""
        first = True
        while not self.closed:
            if not first:
                stable = self._ready_at is not None and time.monotonic() - self._ready_at >= self.stable_after_s
                if stable:
                    self.attempt = 0
                self._ready_at = None
                self.attempt += 1
                delay = min(self.retry_max_s, self.retry_base_s * (2 ** min(self.attempt, 6)))
                await asyncio.sleep(delay)
                if self.closed:
                    return
                try:
                    fresh = await self.refresh()
                    self.token, self.gateway = fresh["token"], fresh["gateway"]
                except asyncio.CancelledError:
                    raise
                except Exception as error:  # noqa: BLE001 - classified by the owner
                    retry = True
                    if self.on_refresh_error:
                        try:
                            retry = self.on_refresh_error(error, self.attempt) is not False
                        except Exception as callback_error:  # noqa: BLE001
                            self._report(callback_error)
                    else:
                        self._report(error)
                    if not retry:
                        self.closed = True
                        if self.on_stopped:
                            self.on_stopped()
                        return
                    continue
            first = False
            try:
                await self._serve()
            except asyncio.CancelledError:
                raise
            except Exception as error:  # noqa: BLE001
                if not self.closed:
                    self._report(error)

    async def _serve(self) -> None:
        async with self.session.ws_connect(self.gateway, heartbeat=None) as ws:
            self._ws = ws
            self._ready_at = None
            awaiting_ack = False
            ack_deadline: float | None = None
            heartbeat_task: asyncio.Task | None = None
            every = 45.0

            async def beat() -> None:
                nonlocal awaiting_ack, ack_deadline
                window = max(0.25, min(self.heartbeat_ack_timeout_s, every))
                while True:
                    await asyncio.sleep(every)
                    if awaiting_ack or ws.closed:
                        continue
                    await ws.send_str(json.dumps({"op": "HEARTBEAT"}))
                    awaiting_ack = True
                    ack_deadline = time.monotonic() + window
                    await asyncio.sleep(window)
                    if awaiting_ack:
                        error = TimeoutError(
                            f"Gateway for {self.domain} stopped acknowledging heartbeats; reconnecting"
                        )
                        if self.on_heartbeat_timeout:
                            self.on_heartbeat_timeout(error)
                        await ws.close(code=4000, message=b"heartbeat ack timeout")
                        return

            try:
                async for msg in ws:
                    if msg.type != aiohttp.WSMsgType.TEXT:
                        if msg.type in (aiohttp.WSMsgType.ERROR, aiohttp.WSMsgType.CLOSED):
                            break
                        continue
                    try:
                        frame = json.loads(msg.data)
                    except ValueError:
                        continue
                    op = frame.get("op")
                    if op == "HELLO":
                        if heartbeat_task:
                            heartbeat_task.cancel()
                        # Floor guards against a pathological interval spinning the CPU.
                        every = max(0.1, float((frame.get("d") or {}).get("heartbeat_interval_ms") or 45000) / 1000)
                        heartbeat_task = asyncio.create_task(beat())
                        await ws.send_str(json.dumps({
                            "op": "IDENTIFY",
                            "d": {"token": self.token, "intents": self.intents, "presence": {"status": "online"}},
                        }))
                    elif op == "HEARTBEAT_ACK":
                        awaiting_ack = False
                    elif op == "READY":
                        self._ready_at = time.monotonic()
                        if self.on_ready:
                            self.on_ready(frame.get("d"))
                    elif op == "DISPATCH":
                        if self.on_dispatch:
                            self.on_dispatch(frame.get("t"), frame.get("d"))
            finally:
                if heartbeat_task:
                    heartbeat_task.cancel()
                self._ws = None
