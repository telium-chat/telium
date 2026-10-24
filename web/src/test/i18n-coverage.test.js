import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EN } from '../lib/i18n/catalog/index.js';
import { parse } from '../lib/i18n/format.js';
import { pseudoCatalog } from '../lib/i18n/pseudo.js';

const SRC = join(process.cwd(), 'src');
const SERVER = join(process.cwd(), '..', 'server');

function sources(dir = SRC, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'test') sources(path, out);
    } else if (/\.(?:js|jsx)$/.test(path)) {
      out.push(path);
    }
  }
  return out;
}

const FILES = sources();
const read = (path) => readFileSync(path, 'utf8');

function code(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '\n')
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\*)/.test(line))
    .join('\n');
}

function literalKeys() {
  const keys = new Map();
  for (const path of FILES) {
    for (const m of code(read(path)).matchAll(/'([^'\n\\]{3,120})'|"([^"\n\\]{3,120})"/g)) {
      const value = m[1] ?? m[2];
      if (Object.hasOwn(EN, value)) keys.set(value, path);
    }
  }
  return keys;
}

function dynamicPrefixes() {
  const prefixes = new Set();
  for (const path of FILES) {
    for (const m of code(read(path)).matchAll(/`([^`$\n]*)\$\{/g)) {
      if (/^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9_]+)*\.$/.test(m[1])) prefixes.add(m[1]);
    }
  }
  return [...prefixes];
}

const DYNAMIC = dynamicPrefixes();
const isDynamic = (key) => DYNAMIC.some((prefix) => key.startsWith(prefix));

const MIGRATED = [
  'App.jsx',
  'hooks/useToast.jsx',
  'lib/clipboard.js',
  'lib/gateway.js',
  'lib/notification-preview.js',
  'lib/perms.js',
  'lib/scheme.js',
  'lib/util.js',
  'views/AccountHome.jsx',
  'views/AccountHomePicker.jsx',
  'views/InviteLanding.jsx',
  'views/LoginView.jsx',
  'views/RecoveryScreen.jsx',
  'views/user-settings/RecoveryPane.jsx',
  'views/user-settings/RecoveryParts.jsx',
  'views/MigrationBanner.jsx',
  'views/user-settings/MigrationDialog.jsx',
  'views/user-settings/ReceiveMigrationDialog.jsx',
  'views/Shell.jsx',
  'lib/failure.js',
  'lib/failover.js',
  'views/dialogs/VerifyDialog.jsx',
  'views/user-settings/AppearancePane.jsx',
  'views/user-settings/DevicesPane.jsx',
  'views/user-settings/NotificationsPane.jsx',
  'views/user-settings/SecurityPane.jsx',
  'components/UpdateStatus.jsx',
  'lib/updates.js',
  'views/UpdateBanner.jsx',
  'views/user-settings/ProfileLookupsPane.jsx',
  'views/chat/Attachments.jsx',
  'views/chat/Autocomplete.jsx',
  'views/chat/Composer.jsx',
  'views/chat/Conversation.jsx',
  'views/chat/DeliveryDetails.jsx',
  'views/chat/EmbedVideo.jsx',
  'views/chat/Embeds.jsx',
  'views/chat/EmojiPicker.jsx',
  'views/chat/EphemeralMessages.jsx',
  'views/chat/FormatBar.jsx',
  'views/chat/ForwardDialog.jsx',
  'views/chat/GifEmbed.jsx',
  'views/chat/GifPicker.jsx',
  'views/chat/ImagePreview.jsx',
  'views/chat/InviteCard.jsx',
  'views/chat/MarkdownInk.jsx',
  'views/chat/MessageRow.jsx',
  'views/chat/PlayableAttachment.jsx',
  'views/chat/PlayableLinkEmbeds.jsx',
  'views/chat/QuotePreview.jsx',
  'views/chat/StagedAttachments.jsx',
  'views/chat/Sticker.jsx',
  'views/chat/Timeline.jsx',
  'views/chat/encryption.jsx',
  'views/chat/formatting.js',
  'views/chat/surface.jsx',
  'views/chat/useStaging.jsx',
  'views/dialogs/EmojiPickerDialog.jsx',
  'views/dialogs/GifPickerDialog.jsx',
  'lib/emoji.js',
  'lib/upload.js',
  'views/guild-settings/GuildSettings.jsx',
  'views/guild-settings/OverviewPane.jsx',
  'views/guild-settings/GatesPane.jsx',
  'views/guild-settings/QueuePane.jsx',
  'views/guild-settings/BansPane.jsx',
  'views/guild-settings/PurgePane.jsx',
  'views/guild-settings/InvitesPane.jsx',
  'views/guild-settings/AuditPane.jsx',
  'views/guild-settings/ExpressionsPane.jsx',
  'views/guild-settings/VoicePane.jsx',
  'views/guild-settings/RolesPane.jsx',
  'views/guild-settings/ChannelPermissionsPane.jsx',
  'views/dialogs/CreateCategoryDialog.jsx',
  'views/dialogs/CreateChannelDialog.jsx',
  'views/dialogs/EditChannelDialog.jsx',
  'views/guild-settings/BotsPane.jsx',
  'components/BotCapabilityChecklist.jsx',
  'components/DataTable.jsx',
  'components/DesktopAudioDevices.jsx',
  'hooks/useVoice.jsx',
  'hooks/useWatch.jsx',
  'views/CallStage.jsx',
  'views/IncomingCall.jsx',
  'views/PersistentMediaMiniView.jsx',
  'views/VoiceBar.jsx',
  'views/VoiceView.jsx',
  'views/call/WatchTogether.jsx',
  'views/dialogs/ScreenShareDialog.jsx',
  'views/dialogs/WatchTogetherDialog.jsx',
];

const PROSE_PROPS = new RegExp(
  '\\b(label|title|placeholder|aria-label|description|hint|alt|heading|summary'
  + '|confirmLabel|cancelLabel|emptyLabel|actionLabel|tooltip)='
  + '(?:"([^"]+)"|\'([^\']+)\')',
  'g',
);

const JSX_TEXT = /(?<![=!<>])>\s*([A-Za-z][^<>{}]*?)\s*</g;

const NOT_A_STRING = new Set(['Telium']);

function looksLikeProse(text) {
  const trimmed = text.trim();
  if (trimmed.length < 3) return false;
  if (NOT_A_STRING.has(trimmed)) return false;
  if (/[();={}]/.test(trimmed)) return false;
  if (/^[a-z$_][\w$]*\.[\w$.]+$/.test(trimmed)) return false;
  if (/^[a-z][a-z0-9-]*$/.test(trimmed)) return false;
  return /[A-Za-z]{3}/.test(trimmed);
}

const jsxText = (src) => [...code(src).matchAll(JSX_TEXT)]
  .map((m) => m[1].replace(/\s+/g, ' ').trim())
  .filter(looksLikeProse);

function prose(path) {
  const src = read(path);
  const found = [];
  for (const m of code(src).matchAll(PROSE_PROPS)) {
    const text = m[2] ?? m[3];
    if (looksLikeProse(text)) found.push(`${m[1]}="${text}"`);
  }
  for (const text of jsxText(src)) found.push(`text "${text}"`);
  return found;
}

describe('the migrated surfaces stay migrated', () => {
  it('names files that exist', () => {
    for (const rel of MIGRATED) {
      expect(() => statSync(join(SRC, rel)), `${rel} is listed as migrated`).not.toThrow();
    }
  });

  for (const rel of MIGRATED) {
    it(`has no prose left in ${rel}`, () => {
      expect(prose(join(SRC, rel))).toEqual([]);
    });
  }

  it('recognises prose when it sees it', () => {
    expect(looksLikeProse('Save changes')).toBe(true);
    expect(looksLikeProse('entry.translated')).toBe(false);
    expect(looksLikeProse('dark')).toBe(false);
    expect(looksLikeProse('(a) => b')).toBe(false);
    expect(looksLikeProse('Telium')).toBe(false);
    expect(looksLikeProse('Welcome to Telium')).toBe(true);
  });

  it('sees wrapped prose but not a JSX comment', () => {
    expect(jsxText('<p>\n  Sessions keep working until they\n  expire.\n</p>'))
      .toEqual(['Sessions keep working until they expire.']);
    expect(jsxText('<div>\n  {/* Why this is here. */}\n  <Button />\n</div>')).toEqual([]);
  });
});

describe('the English catalogue and the code agree', () => {
  const used = literalKeys();

  it('has no key that nothing can ask for', () => {
    const dead = Object.keys(EN).filter((key) => !used.has(key) && !isDynamic(key));
    expect(dead).toEqual([]);
  });

  it('parses every pattern, in English and in every pseudolocale', () => {
    const broken = [];
    for (const [tag, catalog] of [['en', EN], ...['xx-long', 'xx-kana', 'xx-rtl'].map((x) => [x, pseudoCatalog(x)])]) {
      for (const [key, pattern] of Object.entries(catalog)) {
        try { parse(pattern); } catch (e) { broken.push(`${tag} ${key}: ${e.message}`); }
      }
    }
    expect(broken).toEqual([]);
  });
});

describe('the error-code contract', () => {
  const registry = readFileSync(join(SERVER, 'src', 'errcodes.rs'), 'utf8');
  const CODES = new Set(
    [...registry.matchAll(/^pub const [A-Z0-9_]+: &str = "([a-z0-9_]+)";/gm)].map((m) => m[1]),
  );
  const CLIENT_ORIGIN = new Set([
    'opaque_downgrade', 'legacy_auth_required',
    'offline', 'offlineDevice', 'generic', 'context', 'serverFault',
  ]);

  it('translates only codes the server can actually send', () => {
    expect(CODES.size).toBeGreaterThan(30);
    const invented = Object.keys(EN)
      .filter((key) => /^errors\.[a-z][a-zA-Z0-9_]*$/.test(key))
      .map((key) => key.slice('errors.'.length))
      .filter((c) => !CODES.has(c) && !CLIENT_ORIGIN.has(c));
    expect(invented).toEqual([]);
  });

  it('covers the codes a person can be shown', () => {
    const mustHave = [
      'invalid_credentials', 'mfa_required', 'invalid_mfa_code', 'reauth_required',
      'registration_closed', 'username_taken', 'invite_invalid',
      'missing_permission', 'role_hierarchy', 'rate_limited',
      'shut_down', 'standby_read_only', 'migration_in_progress',
    ];
    for (const c of mustHave) {
      expect(CODES.has(c), `${c} is a real server code`).toBe(true);
      expect(Object.hasOwn(EN, `errors.${c}`), `${c} has an English message`).toBe(true);
    }
  });
});
