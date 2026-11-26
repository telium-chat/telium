"""The bot client: home discovery, install-index reconciliation, per-guild-server gateways."""

from __future__ import annotations

import asyncio
import inspect
import json
import time
from dataclasses import dataclass
from typing import Any, Callable
from urllib.parse import quote

import aiohttp

from .discovery import Discovered, discover, require_gateway_url
from .errors import (
    HttpError, is_auth_error, is_not_installed, is_terminal_http_error,
)
from .gateway import GatewayConnection
from .http import request

DEFAULT_INSTALLATION_REFRESH_S = 5.0
AUTH_RETRY_LIMIT = 10


@dataclass
class Context:
    """Passed to event handlers alongside the payload."""

    domain: str


def _fingerprint(rows: list[dict]) -> str:
    ordered = sorted(rows, key=lambda r: str(r.get("guild_id")))
    return "|".join(
        json.dumps([r.get("guild_id"), r.get("installed_at"), r.get("allowed_intents"), r.get("permissions")])
        for r in ordered
    )


class BotClient:
    def __init__(
        self,
        *,
        home: str,
        token: str,
        intents: list[str] | None = None,
        installation_refresh_s: float | bool = DEFAULT_INSTALLATION_REFRESH_S,
        allow_insecure_http: bool | None = None,
        request_timeout: float | None = None,
        auth_retry_limit: int = AUTH_RETRY_LIMIT,
        discovery_transport: dict | None = None,
        session: aiohttp.ClientSession | None = None,
    ):
        if not home or not token:
            raise ValueError("home and token are required")
        self.home = home
        self.token = token
        self.intents = list(intents) if intents is not None else ["GUILD_MESSAGES", "GUILD_STRUCTURE"]
        self.allow_insecure_http = allow_insecure_http
        self.request_timeout = request_timeout
        self.discovery_transport = discovery_transport or {}
        self.auth_retry_limit = max(1, int(auth_retry_limit or AUTH_RETRY_LIMIT))
        self.installation_refresh_s = (
            0.0 if installation_refresh_s is False
            else max(1.0, float(installation_refresh_s or DEFAULT_INSTALLATION_REFRESH_S))
        )
        self.home_info: Discovered | None = None
        self.installations: list[dict] = []
        self.connections: dict[str, dict] = {}
        self.connecting_domains: set[str] = set()
        self.channel_domains: dict[str, str] = {}
        self.handlers: dict[str, list[Callable]] = {}
        self.domain_fingerprints: dict[str, str] = {}
        self.suppressed_domains: dict[str, str] = {}
        self.auth_failures: dict[str, int] = {}
        self.domain_retry_at: dict[str, float] = {}
        self.closed = False
        self._session = session
        self._owns_session = session is None
        self._refresh_task: asyncio.Task | None = None
        self._refresh_failures = 0
        self._sync_lock = asyncio.Lock()
        self._tasks: set[asyncio.Task] = set()

    # ---- events -----------------------------------------------------------------------------

    def on(self, event: str, handler: Callable | None = None):
        """Register ``handler`` for ``event``; usable as ``@bot.on("MESSAGE_CREATE")``.

        Returns an unsubscribe function when called with a handler. ``"*"`` receives
        ``(event, *args)`` for every event.
        """
        if handler is None:
            def decorator(fn: Callable) -> Callable:
                self.on(event, fn)
                return fn
            return decorator
        self.handlers.setdefault(event, []).append(handler)

        def off() -> None:
            if handler in self.handlers.get(event, []):
                self.handlers[event].remove(handler)
        return off

    def _handler_failed(self, event: str, error: BaseException) -> None:
        if event != "error" and self.handlers.get("error"):
            self.emit("error", error, {"phase": "handler", "event": event})
            return
        loop = asyncio.get_running_loop()
        loop.call_exception_handler({"message": f"unhandled error in {event!r} handler",
                                     "exception": error})

    def _invoke(self, event: str, handler: Callable, args: tuple) -> None:
        try:
            result = handler(*args)
        except Exception as error:  # noqa: BLE001
            self._handler_failed(event, error)
            return
        if inspect.isawaitable(result):
            async def run() -> None:
                try:
                    await result
                except Exception as error:  # noqa: BLE001
                    self._handler_failed(event, error)
            task = asyncio.ensure_future(run())
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)

    def emit(self, event: str, *args: Any) -> None:
        for handler in list(self.handlers.get(event, [])):
            self._invoke(event, handler, args)
        for handler in list(self.handlers.get("*", [])):
            self._invoke(event, handler, (event, *args))

    # ---- lifecycle --------------------------------------------------------------------------

    @property
    def session(self) -> aiohttp.ClientSession:
        if self._session is None:
            self._session = aiohttp.ClientSession()
        return self._session

    def _discovery_options(self, expect: str | None = None) -> dict:
        return {
            "allow_insecure_http": self.allow_insecure_http,
            "timeout": self.request_timeout,
            **({"expect_server_name": expect} if expect else {}),
            **self.discovery_transport,
        }

    async def login(self) -> "BotClient":
        self.closed = False
        self.home_info = await discover(self.home, **self._discovery_options())
        result = await self.refresh_installations(phase="login")
        self._schedule_refresh()
        self.emit("ready", {
            "installations": self.installations,
            "domains": result["connected"],
            "unavailable_domains": result["unavailable"],
        })
        return self

    async def run(self) -> None:
        """Log in and block until :meth:`close` is called (or the task is cancelled)."""
        await self.login()
        try:
            while not self.closed:
                await asyncio.sleep(0.5)
        finally:
            await self.close()

    async def fetch_installations(self) -> list[dict]:
        if not self.home_info:
            raise RuntimeError("BotClient is not logged in")
        index = await request(
            self.session, self.home_info.api, "GET", "/_telium/v1/bots/installations",
            bot_token=self.token, timeout=self.request_timeout,
        )
        return (index or {}).get("installations") or []

    async def refresh_installations(self, *, phase: str = "installation-refresh") -> dict:
        if self.closed:
            return {"connected": [], "unavailable": []}
        async with self._sync_lock:
            if self.closed:
                return {"connected": [], "unavailable": []}
            return await self._reconcile(phase)

    async def _reconcile(self, phase: str) -> dict:
        installations = await self.fetch_installations()
        if self.closed:
            return {"connected": [], "unavailable": []}
        self.installations = installations
        grouped: dict[str, list[dict]] = {}
        for row in installations:
            if row.get("guild_domain"):
                grouped.setdefault(row["guild_domain"], []).append(row)

        # A domain gone from the home index is no authority to stay connected to.
        for domain in list(self.connections):
            if domain not in grouped:
                await self.disconnect_domain(domain)
        for domain in list(self.domain_fingerprints):
            if domain not in grouped:
                self.domain_fingerprints.pop(domain, None)
                self.suppressed_domains.pop(domain, None)
                self.clear_auth_failure(domain)

        to_connect: list[tuple[str, str]] = []
        for domain, rows in grouped.items():
            fingerprint = _fingerprint(rows)
            previous = self.domain_fingerprints.get(domain)
            suppressed = self.suppressed_domains.get(domain)
            # Reinstalling changes installed_at, so a changed fingerprint releases a 403 suppression.
            if suppressed and suppressed != fingerprint:
                self.suppressed_domains.pop(domain, None)
            # One connection per homeserver: any install-set or grant change needs a fresh READY.
            if domain in self.connections and previous is not None and previous != fingerprint:
                await self.disconnect_domain(domain)
            if previous is not None and previous != fingerprint:
                self.clear_auth_failure(domain)
            self.domain_fingerprints[domain] = fingerprint
            retry_at = self.domain_retry_at.get(domain)
            if retry_at is not None and time.monotonic() < retry_at:
                continue
            if (domain not in self.connections and domain not in self.connecting_domains
                    and self.suppressed_domains.get(domain) != fingerprint):
                to_connect.append((domain, fingerprint))

        results = await asyncio.gather(
            *(self.connect_domain(d) for d, _ in to_connect), return_exceptions=True,
        )
        unavailable: list[str] = []
        for (domain, fingerprint), result in zip(to_connect, results):
            if not isinstance(result, BaseException):
                self.clear_auth_failure(domain)
                continue
            unavailable.append(domain)
            self._connect_failed(domain, fingerprint, result, phase)
        return {"connected": list(self.connections), "unavailable": unavailable}

    def _connect_failed(self, domain: str, fingerprint: str, error: BaseException, phase: str) -> None:
        status = getattr(error, "status", None)
        if is_not_installed(error):
            self.suppressed_domains[domain] = fingerprint
            self.emit("warning", {
                "code": "INSTALLATION_INACTIVE",
                "message": f"Telium no longer sees this bot installed on {domain}; waiting for the "
                           "installation index to change before reconnecting.",
                "domain": domain, "phase": phase, "status": status,
            })
        elif is_auth_error(error):
            count = self.note_auth_failure(domain)
            if count < self.auth_retry_limit:
                self.emit("warning", {
                    "code": "GUILD_AUTH_RETRY",
                    "message": f"Could not authorise with {domain} (HTTP {status}); Telium will retry "
                               f"with backoff ({count}/{self.auth_retry_limit}).",
                    "domain": domain, "phase": phase, "status": status, "attempt": count,
                    "limit": self.auth_retry_limit, "cause": error,
                })
            else:
                self.clear_auth_failure(domain)
                self.suppressed_domains[domain] = fingerprint
                self.emit("error", error, {"domain": domain, "phase": phase, "terminal": True, "attempts": count})
        elif is_terminal_http_error(error):
            self.suppressed_domains[domain] = fingerprint
            self.emit("error", error, {"domain": domain, "phase": phase, "terminal": True})
        else:
            self.emit("warning", {
                "code": "GUILD_CONNECT_RETRY",
                "message": f"Could not connect to {domain}; Telium will retry automatically.",
                "domain": domain, "phase": phase, "status": status, "cause": error,
            })

    def note_auth_failure(self, domain: str) -> int:
        count = self.auth_failures.get(domain, 0) + 1
        self.auth_failures[domain] = count
        self.domain_retry_at[domain] = time.monotonic() + min(30.0, 2.0 ** min(count, 5))
        return count

    def clear_auth_failure(self, domain: str) -> None:
        self.auth_failures.pop(domain, None)
        self.domain_retry_at.pop(domain, None)

    def _schedule_refresh(self, delay: float | None = None) -> None:
        if self._refresh_task:
            self._refresh_task.cancel()
            self._refresh_task = None
        if self.closed or self.installation_refresh_s <= 0:
            return
        wait = self.installation_refresh_s if delay is None else max(0.0, delay)

        async def tick() -> None:
            await asyncio.sleep(wait)
            if self.closed:
                return
            try:
                await self.refresh_installations()
                self._refresh_failures = 0
                nxt = None
            except asyncio.CancelledError:
                raise
            except Exception as error:  # noqa: BLE001
                self._refresh_failures += 1
                self.emit("warning", {
                    "code": "INSTALLATION_INDEX_RETRY",
                    "message": "Could not refresh bot installations from the bot home; "
                               "Telium will retry automatically.",
                    "status": getattr(error, "status", None), "cause": error,
                })
                nxt = min(30.0, self.installation_refresh_s * (2 ** min(self._refresh_failures, 3)))
            self._schedule_refresh(nxt)

        self._refresh_task = asyncio.create_task(tick())

    def _expedite_refresh(self, delay: float = 0.25) -> None:
        if self._refresh_failures == 0:
            self._schedule_refresh(delay)

    async def fresh_session(self, domain: str) -> dict:
        # Makes the peer prove its document agrees with the looked-up name.
        remote = await discover(domain, **self._discovery_options(domain))
        asserted = await request(
            self.session, self.home_info.api, "POST", "/_telium/v1/bots/assertions",
            bot_token=self.token,
            # Audience is the indexed domain, never what the contacted server calls itself.
            body={"audience": domain}, timeout=self.request_timeout,
        )
        session = await request(
            self.session, remote.api, "POST", "/_telium/v1/bots/session",
            body={"assertion": asserted["assertion"]}, timeout=self.request_timeout,
        )
        gateway = (
            require_gateway_url(session["gateway"], domain, allow_insecure_http=self.allow_insecure_http)
            if session.get("gateway") else remote.gateway
        )
        return {"remote": remote, "token": session["session_token"], "gateway": gateway}

    def _clear_domain_channels(self, domain: str) -> None:
        for channel_id in [c for c, d in self.channel_domains.items() if d == domain]:
            del self.channel_domains[channel_id]

    async def disconnect_domain(self, domain: str) -> None:
        entry = self.connections.pop(domain, None)
        self._clear_domain_channels(domain)
        if entry:
            await entry["connection"].close()

    def _handle_refresh_error(self, domain: str, error: BaseException, attempt: int) -> bool:
        fingerprint = self.domain_fingerprints.get(domain)
        status = getattr(error, "status", None)
        if is_not_installed(error):
            if fingerprint is not None:
                self.suppressed_domains[domain] = fingerprint
            self.emit("warning", {
                "code": "INSTALLATION_INACTIVE",
                "message": f"The bot is no longer installed on {domain}. Telium will reconnect "
                           "automatically if it is installed again.",
                "domain": domain, "status": status,
            })
            self.clear_auth_failure(domain)
            self._expedite_refresh()
            return False
        if is_auth_error(error):
            count = self.note_auth_failure(domain)
            if count < self.auth_retry_limit:
                self.emit("warning", {
                    "code": "GATEWAY_AUTH_RETRY",
                    "message": f"{domain} rejected the bot's session assertion (HTTP {status}); "
                               f"Telium will retry ({count}/{self.auth_retry_limit}).",
                    "domain": domain, "status": status, "attempt": count,
                    "limit": self.auth_retry_limit, "cause": error,
                })
                return True
            self.clear_auth_failure(domain)
            if fingerprint is not None:
                self.suppressed_domains[domain] = fingerprint
            self.emit("error", error, {"domain": domain, "phase": "gateway-refresh", "terminal": True, "attempts": count})
            return False
        if is_terminal_http_error(error):
            if fingerprint is not None:
                self.suppressed_domains[domain] = fingerprint
            self.emit("error", error, {"domain": domain, "phase": "gateway-refresh", "terminal": True})
            return False
        if attempt == 1 or attempt % 5 == 0:
            self.emit("warning", {
                "code": "GATEWAY_RECONNECT_RETRY",
                "message": f"Connection to {domain} is unavailable; Telium will keep retrying automatically.",
                "domain": domain, "status": status, "attempt": attempt, "cause": error,
            })
        return True

    async def connect_domain(self, domain: str) -> None:
        if self.closed or domain in self.connections or domain in self.connecting_domains:
            return
        self.connecting_domains.add(domain)
        try:
            fresh = await self.fresh_session(domain)
            if self.closed:
                return

            async def refresh() -> dict:
                nxt = await self.fresh_session(domain)
                return {"token": nxt["token"], "gateway": nxt["gateway"]}

            def on_ready(data: Any) -> None:
                self.suppressed_domains.pop(domain, None)
                # READY proves the assertion chain worked, so the auth-failure count is spent.
                self.clear_auth_failure(domain)
                self._clear_domain_channels(domain)
                for guild in (data or {}).get("guilds") or []:
                    for channel in guild.get("channels") or []:
                        self.channel_domains[channel["id"]] = domain
                    granted_list = guild.get("bot_allowed_intent_names")
                    if isinstance(granted_list, list):
                        granted = set(granted_list)
                        missing = [i for i in self.intents if i not in granted]
                        if missing:
                            self.emit("warning", {
                                "code": "MISSING_GUILD_INTENTS",
                                "message": f"Guild {guild.get('name') or guild.get('id')} is missing "
                                           f"requested bot intents: {', '.join(missing)}",
                                "domain": domain, "guild_id": guild.get("id"), "guild_name": guild.get("name"),
                                "requested_intents": list(self.intents),
                                "granted_intents": sorted(granted), "missing_intents": missing,
                            })
                self.emit("gateway_ready", {"domain": domain, "data": data})

            def on_dispatch(kind: str | None, data: Any) -> None:
                if isinstance(data, dict) and data.get("channel_id"):
                    self.channel_domains[data["channel_id"]] = domain
                self.emit(kind or "dispatch", data, Context(domain=domain))
                self.emit("dispatch", {"type": kind, "data": data, "domain": domain})

            def on_stopped() -> None:
                current = self.connections.get(domain)
                if current and current["connection"] is connection:
                    del self.connections[domain]
                    self._clear_domain_channels(domain)

            connection = GatewayConnection(
                domain=domain, gateway=fresh["gateway"], token=fresh["token"], intents=self.intents,
                session=self.session, refresh=refresh, on_ready=on_ready, on_dispatch=on_dispatch,
                on_error=lambda error: self.emit("warning", {
                    "code": "GATEWAY_SOCKET_ERROR",
                    "message": f"Gateway transport error for {domain}; reconnect will be attempted automatically.",
                    "domain": domain, "cause": error,
                }),
                on_refresh_error=lambda error, attempt: self._handle_refresh_error(domain, error, attempt),
                on_heartbeat_timeout=lambda error: self.emit("warning", {
                    "code": "GATEWAY_HEARTBEAT_TIMEOUT",
                    "message": f"Gateway for {domain} stopped acknowledging heartbeats; the connection is being rebuilt.",
                    "domain": domain, "cause": error,
                }),
                on_stopped=on_stopped,
            )
            self.connections[domain] = {"connection": connection, "remote": fresh["remote"]}
            connection.open()
        finally:
            self.connecting_domains.discard(domain)

    # ---- actions ----------------------------------------------------------------------------

    async def send_message(self, channel_id: str, content: str, *, domain: str | None = None) -> Any:
        domain = domain or self.channel_domains.get(channel_id)
        if not domain:
            raise RuntimeError("Unknown channel homeserver; pass domain= or wait for READY/message activity")
        entry = self.connections.get(domain)
        if not entry:
            raise RuntimeError(f"No bot connection for {domain}")

        async def send(bearer: str) -> Any:
            return await request(
                self.session, entry["remote"].api, "POST",
                f"/_telium/v1/channels/{quote(channel_id, safe='')}/messages",
                bearer=bearer, body={"content": content}, timeout=self.request_timeout,
            )

        try:
            return await send(entry["connection"].token)
        except HttpError as error:
            if error.status != 401:
                raise
            fresh = await self.fresh_session(domain)
            entry["remote"] = fresh["remote"]
            entry["connection"].token = fresh["token"]
            entry["connection"].gateway = fresh["gateway"]
            return await send(fresh["token"])

    async def close(self) -> None:
        self.closed = True
        if self._refresh_task:
            self._refresh_task.cancel()
            self._refresh_task = None
        connections = [e["connection"] for e in self.connections.values()]
        self.connections.clear()
        for connection in connections:
            await connection.close()
        for task in list(self._tasks):
            task.cancel()
        self.connecting_domains.clear()
        self.channel_domains.clear()
        self.domain_fingerprints.clear()
        self.suppressed_domains.clear()
        self.auth_failures.clear()
        self.domain_retry_at.clear()
        if self._owns_session and self._session is not None:
            await self._session.close()
            self._session = None

    async def __aenter__(self) -> "BotClient":
        return await self.login()

    async def __aexit__(self, *exc: Any) -> None:
        await self.close()
