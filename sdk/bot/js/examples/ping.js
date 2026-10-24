import { BotClient } from '../src/index.js';

const home = process.env.TELIUM_BOT_HOME;
const token = process.env.TELIUM_BOT_TOKEN;
if (!home || !token) throw new Error('Set TELIUM_BOT_HOME and TELIUM_BOT_TOKEN');

const bot = new BotClient({
  home,
  token,
  intents: ['GUILD_MESSAGES', 'MESSAGE_CONTENT', 'GUILD_STRUCTURE'],
});

const redactionWarnings = new Set();

bot.on('warning', (warning) => {
  console.warn(`[Telium bot warning] ${warning.message || warning.code}`);
  if (warning.code === 'MISSING_GUILD_INTENTS' && warning.missingIntents?.includes('MESSAGE_CONTENT')) {
    console.warn(
      'Grant MESSAGE_CONTENT in both User Settings > Developer and Guild Settings > Bots, then restart this example.',
    );
  }
});

bot.on('MESSAGE_CREATE', async (message, { domain }) => {
  if (message.author === process.env.TELIUM_BOT_USER_ID) return;
  if (message.content_redacted) {
    const key = `${domain}:${message.guild_id}`;
    if (!redactionWarnings.has(key)) {
      redactionWarnings.add(key);
      console.warn(
        '[Telium bot warning] Message content is redacted. Grant MESSAGE_CONTENT in both the application ceiling and this guild.',
      );
    }
    return;
  }
  if (message.content === '!ping') {
    await bot.sendMessage(message.channel_id, 'Pong!', { domain });
  }
});

bot.on('error', (error) => console.error(error));
await bot.login();
