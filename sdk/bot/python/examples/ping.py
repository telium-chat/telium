"""Replies "Pong!" to "!ping". Set TELIUM_BOT_HOME and TELIUM_BOT_TOKEN."""

import asyncio
import os

from telium_bot import BotClient

bot = BotClient(
    home=os.environ["TELIUM_BOT_HOME"],
    token=os.environ["TELIUM_BOT_TOKEN"],
    intents=["GUILD_MESSAGES", "MESSAGE_CONTENT", "GUILD_STRUCTURE"],
)
redaction_warned: set[str] = set()


@bot.on("warning")
def on_warning(warning):
    print(f"[Telium bot warning] {warning.get('message') or warning.get('code')}")


@bot.on("error")
def on_error(error, info=None):
    print("[Telium bot error]", repr(error), info or "")


@bot.on("MESSAGE_CREATE")
async def on_message(message, ctx):
    if message.get("author") == os.environ.get("TELIUM_BOT_USER_ID"):
        return
    if message.get("content_redacted"):
        key = f"{ctx.domain}:{message.get('guild_id')}"
        if key not in redaction_warned:
            redaction_warned.add(key)
            print("Message content is redacted. Grant MESSAGE_CONTENT in both the application ceiling and this guild.")
        return
    if message.get("content") == "!ping":
        await bot.send_message(message["channel_id"], "Pong!", domain=ctx.domain)


asyncio.run(bot.run())
