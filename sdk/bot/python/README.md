# telium-bot

First-party asyncio client for Telium bots in Python. It mirrors [`@telium/bot`](../js) and follows the same security and reconnect rules. Requires Python 3.10+ and `aiohttp`.

```python
import asyncio, os
from telium_bot import BotClient

bot = BotClient(
    home="bots.example",
    token=os.environ["TELIUM_BOT_TOKEN"],
    intents=["GUILD_MESSAGES", "MESSAGE_CONTENT", "GUILD_STRUCTURE"],
)

@bot.on("MESSAGE_CREATE")
async def on_message(message, ctx):
    if message["content"] == "!ping":
        await bot.send_message(message["channel_id"], "Pong!", domain=ctx.domain)

asyncio.run(bot.run())   # or: async with bot: ...
```

Handlers are called as `handler(payload, ctx)`, where `ctx.domain` is the guild server the event came from. They may be sync or `async`; an exception is delivered to your `error` handler (or the loop's exception handler if there is none). `bot.on("*", handler)` receives `(event, *args)` for everything. Besides gateway event names (`MESSAGE_CREATE`, …) the client emits `ready`, `gateway_ready`, `warning` and `error`.

## Behaviour (same as the JS client)

- The long-lived token goes only to the bot home, only over TLS. The SDK exchanges it for audience-bound assertions and short-lived guild-server sessions; reconnects create fresh sessions.
- Discovery is https-only. A bare domain is never retried in the clear, and the `api` and `gateway` a server publishes must be TLS and stay on the dialled domain or a delegation beneath it. Discovery connections refuse non-public addresses, redirects and oversized bodies. Set `TELIUM_BOT_INSECURE_ALLOW_PLAINTEXT_HTTP=1`, or pass `allow_insecure_http=True`, for local development only.
- The bot home's installation index is polled (every 5 s by default, with backoff), so installing, removing or reinstalling a bot needs no restart. `installation_refresh_s=False` turns this off.
- Guild-server outages are transient: sessions are refreshed with bounded exponential backoff. Auth failures retry up to `auth_retry_limit` (10) and then raise a `terminal` error; a `bot_not_installed` refusal stops that domain until the index changes.
- Gateway connections are heartbeat-acknowledged; a silent socket is dropped and rebuilt.

Differences from JS: names are `snake_case` (`send_message`, `allow_insecure_http`, `installation_refresh_s`, `request_timeout`, in seconds), and warning payload keys are `snake_case` too (`missing_intents`, `guild_id`).

## Tests

```bash
pip install -e '.[test]'
pytest
```
