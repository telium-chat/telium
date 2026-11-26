"""End-to-end against a local mock home/guild server (plaintext, via the explicit dev opt-in)."""

import asyncio
import json

import pytest
from aiohttp import WSMsgType, web

from telium_bot import BotClient, HttpError
from telium_bot.http import request


async def wait_for(predicate, timeout=5.0):
    end = asyncio.get_running_loop().time() + timeout
    while not predicate():
        if asyncio.get_running_loop().time() > end:
            raise AssertionError("timed out")
        await asyncio.sleep(0.02)


@pytest.fixture
async def server(aiohttp_server):
    state = {"sent": [], "auth": [], "installed": True, "ws_frames": [], "ws": None}

    async def well_known(request_):
        host = request_.host
        return web.json_response({
            "server_name": host,
            "api": f"http://{host}", "gateway": f"ws://{host}/gateway",
        })

    async def installations(request_):
        state["auth"].append(request_.headers.get("Authorization"))
        rows = [{"guild_id": "g1", "guild_domain": request_.host, "installed_at": 1,
                 "allowed_intents": "1", "permissions": "3"}] if state["installed"] else []
        return web.json_response({"installations": rows})

    async def assertions(request_):
        body = await request_.json()
        assert body["audience"] == request_.host
        return web.json_response({"assertion": "A"})

    async def session(request_):
        assert (await request_.json())["assertion"] == "A"
        return web.json_response({"session_token": "S"})

    async def post_message(request_):
        state["sent"].append((request_.match_info["cid"], request_.headers.get("Authorization"),
                              (await request_.json())["content"]))
        return web.json_response({"id": "m1"})

    async def gateway(request_):
        ws = web.WebSocketResponse()
        await ws.prepare(request_)
        state["ws"] = ws
        await ws.send_json({"op": "HELLO", "d": {"heartbeat_interval_ms": 200}})
        async for msg in ws:
            if msg.type != WSMsgType.TEXT:
                continue
            frame = json.loads(msg.data)
            state["ws_frames"].append(frame)
            if frame["op"] == "IDENTIFY":
                await ws.send_json({"op": "READY", "d": {"guilds": [{
                    "id": "g1", "name": "G", "channels": [{"id": "c1"}],
                    "bot_allowed_intent_names": ["GUILD_MESSAGES"]}]}})
            elif frame["op"] == "HEARTBEAT":
                await ws.send_json({"op": "HEARTBEAT_ACK"})
        return ws

    app = web.Application()
    app.router.add_get("/.well-known/telium/server", well_known)
    app.router.add_get("/_telium/v1/bots/installations", installations)
    app.router.add_post("/_telium/v1/bots/assertions", assertions)
    app.router.add_post("/_telium/v1/bots/session", session)
    app.router.add_post("/_telium/v1/channels/{cid}/messages", post_message)
    app.router.add_get("/gateway", gateway)
    srv = await aiohttp_server(app)
    state["host"] = f"127.0.0.1:{srv.port}"
    return state


async def test_login_dispatch_and_reply(server):
    host = server["host"]
    bot = BotClient(home=f"http://{host}", token="secret", allow_insecure_http=True,
                    intents=["GUILD_MESSAGES", "MESSAGE_CONTENT"], installation_refresh_s=False)
    warnings, got = [], []

    @bot.on("warning")
    def _(w):
        warnings.append(w)

    @bot.on("MESSAGE_CREATE")
    async def on_message(message, ctx):
        got.append((message["content"], ctx.domain))
        await bot.send_message(message["channel_id"], "Pong!", domain=ctx.domain)

    async with bot:
        await wait_for(lambda: server["ws"] is not None and server["ws_frames"])
        identify = server["ws_frames"][0]
        assert identify["op"] == "IDENTIFY"
        assert identify["d"]["token"] == "S" and identify["d"]["intents"] == ["GUILD_MESSAGES", "MESSAGE_CONTENT"]
        await wait_for(lambda: "c1" in bot.channel_domains)
        # The long-lived token went to the home only, as `Bot`.
        assert server["auth"] == ["Bot secret"]
        await server["ws"].send_json({"op": "DISPATCH", "t": "MESSAGE_CREATE",
                                      "d": {"channel_id": "c1", "content": "!ping"}})
        await wait_for(lambda: server["sent"])
    assert got == [("!ping", host)]
    assert server["sent"] == [("c1", "Bearer S", "Pong!")]
    # Granted intents lacked MESSAGE_CONTENT.
    assert [w["code"] for w in warnings] == ["MISSING_GUILD_INTENTS"]
    assert warnings[0]["missing_intents"] == ["MESSAGE_CONTENT"]


async def test_handler_failure_goes_to_error_handler(server):
    host = server["host"]
    bot = BotClient(home=f"http://{host}", token="t", allow_insecure_http=True, installation_refresh_s=False)
    errors = []
    bot.on("error", lambda e, info=None: errors.append((str(e), info)))

    async def boom(message, ctx):
        raise ValueError("bad")

    bot.on("MESSAGE_CREATE", boom)
    async with bot:
        await wait_for(lambda: server["ws"] is not None and "c1" in bot.channel_domains)
        await server["ws"].send_json({"op": "DISPATCH", "t": "MESSAGE_CREATE", "d": {"channel_id": "c1"}})
        await wait_for(lambda: errors)
    assert errors[0][0] == "bad" and errors[0][1]["phase"] == "handler"


async def test_uninstall_disconnects_and_reinstall_reconnects(server):
    host = server["host"]
    bot = BotClient(home=f"http://{host}", token="t", allow_insecure_http=True, installation_refresh_s=False)
    async with bot:
        await wait_for(lambda: host in bot.connections)
        server["installed"] = False
        await bot.refresh_installations()
        assert host not in bot.connections and "c1" not in bot.channel_domains
        server["installed"] = True
        server["ws_frames"].clear()
        await bot.refresh_installations()
        await wait_for(lambda: any(f["op"] == "IDENTIFY" for f in server["ws_frames"]))


async def test_http_retries_429_and_raises_with_body(aiohttp_server):
    calls = {"n": 0}

    async def flaky(_):
        calls["n"] += 1
        if calls["n"] == 1:
            return web.json_response({"retry_after": 0}, status=429)
        return web.json_response({"ok": True})

    async def nope(_):
        return web.json_response({"code": "bot_not_installed", "message": "no"}, status=403)

    app = web.Application()
    app.router.add_get("/flaky", flaky)
    app.router.add_get("/nope", nope)
    srv = await aiohttp_server(app)
    import aiohttp
    async with aiohttp.ClientSession() as s:
        base = f"http://127.0.0.1:{srv.port}"
        assert await request(s, base, "GET", "/flaky") == {"ok": True}
        with pytest.raises(HttpError) as info:
            await request(s, base, "GET", "/nope")
        assert info.value.status == 403 and info.value.body["code"] == "bot_not_installed"
        with pytest.raises(ValueError):
            await request(s, base, "GET", "/flaky", bearer="a", bot_token="b")


def test_requires_home_and_token():
    with pytest.raises(ValueError):
        BotClient(home="", token="x")
