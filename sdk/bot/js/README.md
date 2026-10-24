# @telium/bot

Minimal first-party JavaScript client for Telium bots.

```js
import { BotClient } from '@telium/bot';

const bot = new BotClient({
  home: 'bots.example',
  token: process.env.TELIUM_BOT_TOKEN,
  intents: ['GUILD_MESSAGES', 'MESSAGE_CONTENT', 'GUILD_STRUCTURE'],
});

bot.on('MESSAGE_CREATE', async (message, { domain }) => {
  if (message.content === '!ping') {
    await bot.sendMessage(message.channel_id, 'Pong!', { domain });
  }
});

await bot.login();
```

The long-lived token is sent only to the bot's identity home, and only over TLS. The SDK exchanges it for audience-bound assertions and short-lived guild-server sessions. Reconnects create fresh sessions; Telium gateway v1 does not yet promise resumable sessions.

Discovery is https-only: a bare domain is never retried in the clear, and the `api` and `gateway` a server publishes must be TLS and stay on the domain that was dialled (or a delegation beneath it). Set `TELIUM_BOT_INSECURE_ALLOW_PLAINTEXT_HTTP=1`, or pass `allowInsecureHttp: true`, to relax this for local development only. The audience of every assertion is the guild domain the bot home's installation index named, never a name a contacted server gives for itself.

The client keeps the bot home's installation index live while the process is running. By default it refreshes every five seconds (with backoff while the home is unavailable), so adding, removing, or reinstalling a bot does not require restarting the bot process. Set `installationRefreshMs: false` only for unusual applications that manage installation reconciliation themselves.

A guild-server restart is treated as transient. Gateway session refreshes retry with bounded exponential backoff through connection failures, request timeouts and 5xx responses. Authorisation failures — a 401, or a 403 that is not the not-installed case — are retried the same way, because clock skew and key rotation resolve themselves; after `authRetryLimit` consecutive failures (ten by default) the domain is suppressed and an `error` with `terminal: true` is raised. A 400 or 404 is terminal immediately. A definite "bot is not installed on this guild server" (the `bot_not_installed` code, or that sentence from a server that does not yet send a code) is different again: that domain is stopped instead of retried forever, and a later installation-index change releases it automatically.

Gateway connections are heartbeat-acknowledged. If the server stops answering `HEARTBEAT` with `HEARTBEAT_ACK`, the socket is dropped and rebuilt rather than left half-open, so a bot cannot go silently deaf.

Event handlers may be `async`. A rejected handler promise is delivered to your `error` handler rather than becoming an unhandled rejection.
