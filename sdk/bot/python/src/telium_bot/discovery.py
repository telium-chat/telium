"""Server discovery. https-only by default; the token must reach exactly one authority."""

from __future__ import annotations

import asyncio
import ipaddress
import json
import os
import re
import socket
from dataclasses import dataclass
from typing import Any, Awaitable, Callable
from urllib.parse import urlsplit

import aiohttp
from aiohttp.abc import AbstractResolver

from .errors import DiscoveryError, HttpError

# Deliberately long so it is visible in `ps`, Dockerfiles and unit files.
INSECURE_HTTP_ENV = "TELIUM_BOT_INSECURE_ALLOW_PLAINTEXT_HTTP"
DISCOVERY_LIMIT = 256 * 1024
POINTER_LIMIT = 512
TIMEOUT_S = 8.0

_NON_PUBLIC = [
    ipaddress.ip_network(n)
    for n in (
        "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16",
        "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.168.0.0/16", "198.18.0.0/15",
        "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
        "::/128", "::1/128", "fc00::/7", "fe80::/10", "ff00::/8", "2001:db8::/32",
        "2001::/32", "2002::/16", "64:ff9b::/96",
    )
]


def public_address(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped is not None:
        addr = addr.ipv4_mapped
    return not any(addr in net for net in _NON_PUBLIC)


class PublicOnlyResolver(AbstractResolver):
    """Refuses any name that resolves to a non-public address; TLS still checks the hostname."""

    async def resolve(self, host: str, port: int = 0, family: int = socket.AF_INET):
        loop = asyncio.get_running_loop()
        infos = await loop.getaddrinfo(host, port, family=socket.AF_UNSPEC, type=socket.SOCK_STREAM)
        if not infos or any(not public_address(i[4][0]) for i in infos):
            raise DiscoveryError("discovery hostname resolves to a non-public address")
        return [
            {"hostname": host, "host": i[4][0], "port": port, "family": i[0], "proto": 0, "flags": 0}
            for i in infos
        ]

    async def close(self) -> None:  # pragma: no cover - nothing to release
        return None


def insecure_http_allowed(explicit: bool | None) -> bool:
    if explicit is not None:
        return explicit is True
    return os.environ.get(INSECURE_HTTP_ENV) in ("1", "true")


def _parse(value: Any):
    try:
        parts = urlsplit(str(value))
        if not parts.scheme or not parts.hostname:
            return None
        return parts
    except ValueError:
        return None


def _within_delegation(host: str, dialled: str) -> bool:
    a, b = (host or "").lower(), (dialled or "").lower()
    return bool(a and b) and (a == b or a.endswith("." + b))


def _require_endpoint(*, value, label, dialled, allow_insecure, secure, insecure):
    url = _parse(value)
    if url is None:
        raise DiscoveryError(f"{dialled} published an unusable {label} in its discovery document: {value}")
    if url.scheme != secure:
        if url.scheme != insecure:
            raise DiscoveryError(
                f"{dialled} published a {label} that is not {secure}:// ({url.scheme}://); "
                "refusing to send bot credentials over it"
            )
        if not allow_insecure:
            raise DiscoveryError(
                f"{dialled} published a plaintext {label} ({value}). Telium bot credentials are only "
                f"sent over TLS; set {INSECURE_HTTP_ENV}=1 to allow this for local development only."
            )
    if not _within_delegation(url.hostname, dialled):
        raise DiscoveryError(
            f"{dialled} published a {label} on {url.hostname}, which is not {dialled} or a delegation "
            "beneath it; refusing to follow a discovery document to another origin"
        )
    return url


def _normalise(url) -> str:
    return url.geturl().rstrip("/")


def require_gateway_url(value: str, dialled: str, *, allow_insecure_http: bool | None = None) -> str:
    return _normalise(_require_endpoint(
        value=value, label="gateway", dialled=dialled,
        allow_insecure=insecure_http_allowed(allow_insecure_http), secure="wss", insecure="ws",
    ))


def parse_txt_pointer(body: Any, domain: str) -> str:
    if not isinstance(body, str) or len(body.encode()) > POINTER_LIMIT:
        raise DiscoveryError("telium.txt exceeded 512 bytes")
    line = body.strip()
    if not line or "\n" in line or "\r" in line:
        raise DiscoveryError("telium.txt must be one line")
    target = urlsplit(line if re.match(r"^[a-z]+://", line, re.I) else "https://" + line)
    host = (target.hostname or "").lower()
    account = domain.lower()
    if (target.scheme != "https" or target.username or target.password or target.port
            or target.path not in ("", "/") or target.query or target.fragment
            or not (host == account or host.endswith("." + account))):
        raise DiscoveryError("telium.txt must target an HTTPS account-domain subdomain")
    return f"https://{host}"


async def _pinned_get(url: str, limit: int, accept: str) -> str:
    parts = urlsplit(url)
    if parts.scheme != "https" or parts.username or parts.password:
        raise DiscoveryError("discovery requires HTTPS without URL credentials")
    connector = aiohttp.TCPConnector(resolver=PublicOnlyResolver(), force_close=True)
    try:
        async with aiohttp.ClientSession(connector=connector) as session:
            async with session.get(
                url,
                allow_redirects=False,
                headers={"Accept": accept, "Accept-Encoding": "identity", "User-Agent": "telium-bot-sdk-python/0.2.0"},
                timeout=aiohttp.ClientTimeout(total=TIMEOUT_S),
            ) as response:
                if response.status != 200:
                    raise HttpError(f"discovery returned HTTP {response.status}", status=response.status)
                declared = response.content_length
                if declared is not None and declared > limit:
                    raise DiscoveryError("discovery exceeded byte limit")
                chunks, size = [], 0
                async for part in response.content.iter_chunked(8192):
                    size += len(part)
                    if size > limit:
                        raise DiscoveryError("discovery exceeded byte limit")
                    chunks.append(part)
                return b"".join(chunks).decode("utf-8")
    except asyncio.TimeoutError as exc:
        raise DiscoveryError("discovery timed out") from exc


async def get_json(url: str) -> Any:
    return json.loads(await _pinned_get(url, DISCOVERY_LIMIT, "application/json"))


async def get_text(url: str) -> str:
    return await _pinned_get(url, POINTER_LIMIT, "text/plain")


@dataclass
class Discovered:
    server_name: str | None
    domain: str
    api: str
    gateway: str


async def _plain_get_json(url: str, timeout: float | None) -> Any:
    # Only reachable with the explicit local-development opt-in.
    async with aiohttp.ClientSession() as session:
        async with session.get(url, allow_redirects=False,
                               timeout=aiohttp.ClientTimeout(total=timeout or TIMEOUT_S)) as response:
            if response.status != 200:
                raise HttpError(f"HTTP {response.status}", status=response.status)
            return json.loads(await response.text())


async def _try_txt(seed, dialled, expect, get_text_fn, get_json_fn):
    target = parse_txt_pointer(await get_text_fn(seed + "/telium.txt"), dialled)
    doc = await get_json_fn(target + "/.well-known/telium/server")
    expected = expect or dialled
    if not isinstance(doc, dict) or str(doc.get("server_name", "")).lower() != expected.lower():
        raise DiscoveryError(f"{target} does not claim the account domain {expected}")
    api = _parse(doc.get("api"))
    if api is None or f"{api.scheme}://{api.netloc}" != target:
        raise DiscoveryError(f"{target} advertised a different API origin")
    return doc


async def discover(
    server: str,
    *,
    allow_insecure_http: bool | None = None,
    expect_server_name: str | None = None,
    timeout: float | None = None,
    direct_get_json: Callable[[str], Awaitable[Any]] = get_json,
    txt_get_json: Callable[[str], Awaitable[Any]] = get_json,
    txt_get_text: Callable[[str], Awaitable[str]] = get_text,
) -> Discovered:
    allow_insecure = insecure_http_allowed(allow_insecure_http)
    explicit = bool(re.match(r"^[a-z][a-z0-9+.-]*://", server, re.I))

    if explicit:
        url = _parse(server)
        if url is None or url.scheme not in ("https", "http"):
            raise DiscoveryError(f"{server} is not an http(s) address")
        if url.scheme == "http" and not allow_insecure:
            raise DiscoveryError(
                f"Refusing to discover {server} over plaintext HTTP; the bot's long-lived token would "
                f"follow it. Set {INSECURE_HTTP_ENV}=1 to allow this for local development only."
            )
        seeds = [server.rstrip("/")]
        dialled = url.hostname
    else:
        # https only unless explicitly local: an http fallback lets a packet-dropper capture the token.
        seeds = [f"https://{server}", f"http://{server}"] if allow_insecure else [f"https://{server}"]
        dialled = server.split("/")[0].split(":")[0]

    last_error: BaseException | None = None
    for seed in seeds:
        doc: Any = None
        try_txt = False
        try:
            if seed.startswith("https://"):
                doc = await direct_get_json(seed + "/.well-known/telium/server")
            else:
                doc = await _plain_get_json(seed + "/.well-known/telium/server", timeout)
            if not isinstance(doc, dict) or not isinstance(doc.get("server_name"), str):
                try_txt = True
        except (HttpError, ValueError) as exc:
            last_error = exc
            try_txt = getattr(exc, "status", None) == 404 or isinstance(exc, ValueError)
        except (aiohttp.ClientError, asyncio.TimeoutError, OSError, DiscoveryError) as exc:
            # The account domain itself is down; do not fan out more requests.
            last_error = exc
        if try_txt and seed.startswith("https://"):
            # Invalid pointers and identity mismatches fail closed; never retry over HTTP after one.
            doc = await _try_txt(seed, dialled, expect_server_name, txt_get_text, txt_get_json)
        if not isinstance(doc, dict):
            continue

        expected = expect_server_name if expect_server_name is not None else (None if explicit else dialled)
        name = doc.get("server_name")
        if expected and name and str(name).lower() != expected.lower():
            raise DiscoveryError(
                f'{expected} identified itself as "{name}" in its discovery document; refusing to connect'
            )
        api_url = _require_endpoint(
            value=doc.get("api") or seed, label="api base", dialled=dialled,
            allow_insecure=allow_insecure, secure="https", insecure="http",
        )
        api = _normalise(api_url)
        gateway_url = _require_endpoint(
            value=doc.get("gateway") or re.sub(r"^http", "ws", api) + "/gateway/v1",
            label="gateway", dialled=dialled, allow_insecure=allow_insecure, secure="wss", insecure="ws",
        )
        return Discovered(server_name=name, domain=expected or dialled, api=api, gateway=_normalise(gateway_url))
    raise last_error or DiscoveryError(f"Could not discover {server}")
