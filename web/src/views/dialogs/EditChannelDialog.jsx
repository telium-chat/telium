import { useEffect, useState } from 'react';
import { useStore, useStoreEvent } from '../../hooks/useStore.jsx';
import { reportError } from '../../hooks/useToast.jsx';
import { isPrivate } from '../../lib/channels.js';
import { useT } from '../../lib/i18n/react.jsx';
import { PERMISSION_MASKS, permissionInfo, toBits } from '../../lib/perms.js';
import {
  Button, CloseIcon, EmojiText, Field, Hint, IconButton, LockIcon, ModalShell, PlusIcon,
  Select, Switch, Tabs, TagIcon, TextArea, TextInput,
} from '../../components/index.js';

const SLOWMODE = [
  [0, 'channel.slowmode.off', 0],
  [5, 'channel.duration.seconds', 5],
  [10, 'channel.duration.seconds', 10],
  [15, 'channel.duration.seconds', 15],
  [30, 'channel.duration.seconds', 30],
  [60, 'channel.duration.minutes', 1],
  [120, 'channel.duration.minutes', 2],
  [300, 'channel.duration.minutes', 5],
  [600, 'channel.duration.minutes', 10],
  [900, 'channel.duration.minutes', 15],
  [1800, 'channel.duration.minutes', 30],
  [3600, 'channel.duration.hours', 1],
  [7200, 'channel.duration.hours', 2],
  [21600, 'channel.duration.hours', 6],
];

const BITRATES = [32000, 64000, 96000, 128000, 160000, 256000, 384000];

const SORTS = [['activity', 'channel.forum.sort.activity'], ['creation', 'channel.forum.sort.creation']];
const LAYOUTS = [['list', 'channel.forum.layout.list'], ['gallery', 'channel.forum.layout.gallery']];

const MAX_TAGS = 20;
const TAGS_PER_POST = 5;

function groupsFor(type) {
  const general = ['VIEW_CHANNEL', 'MANAGE_CHANNELS', 'MANAGE_ROLES', 'CREATE_INVITE'];
  const text = [
    'SEND_MESSAGES', 'READ_MESSAGE_HISTORY', 'ATTACH_FILES', 'EMBED_LINKS', 'ADD_REACTIONS',
    'USE_EXTERNAL_EMOJI', 'MENTION_EVERYONE', 'MANAGE_MESSAGES',
  ];
  const voice = [
    'CONNECT', 'SPEAK', 'VIDEO', 'STREAM', 'PRIORITY_SPEAKER',
    'MUTE_MEMBERS', 'DEAFEN_MEMBERS', 'MOVE_MEMBERS',
  ];
  if (type === 'category') {
    return [
      ['channel.perms.group.general', general],
      ['channel.perms.group.text', text],
      ['channel.perms.group.voice', voice],
    ];
  }
  if (type === 'voice') {
    return [
      ['channel.perms.group.general', general],
      ['channel.perms.group.chat', text],
      ['channel.perms.group.voice', voice],
    ];
  }
  return [['channel.perms.group.general', general], ['channel.perms.group.text', text]];
}

export function EditChannelDialog({ channel: initial, close, tab: startTab = 'overview' }) {
  const store = useStore();
  const t = useT();
  useStoreEvent('channels', 'roles');
  const channel = store.channels.get(initial.id) || initial;
  const [tab, setTab] = useState(startTab);
  const category = channel.type === 'category';
  const forum = channel.type === 'forum';

  const tabs = [
    ['overview', t('channel.tab.overview')],
    ...(forum ? [['tags', t('channel.tab.tags')]] : []),
    ['permissions', t('channel.tab.permissions')],
  ];

  return (
    <ModalShell
      title={category ? t('channel.edit.titleCategory') : t('channel.edit.title')}
      subtitle={channel.name}
      bodyClassName="min-h-[420px]"
    >
      <Tabs value={tab} onChange={setTab} options={tabs} />
      {tab === 'overview' ? <Overview channel={channel} close={close} /> : null}
      {tab === 'tags' ? <ForumTags channel={channel} close={close} /> : null}
      {tab === 'permissions' ? <Permissions channel={channel} /> : null}
    </ModalShell>
  );
}

function Overview({ channel, close }) {
  const store = useStore();
  const t = useT();
  const guildId = channel.guild_id;
  const voice = channel.type === 'voice';
  const category = channel.type === 'category';
  const forum = channel.type === 'forum';

  const [sort, setSort] = useState(channel.default_sort || 'activity');
  const [layout, setLayout] = useState(channel.default_layout || 'list');
  const [name, setName] = useState(channel.name || '');
  const [topic, setTopic] = useState(channel.topic || '');
  const [parent, setParent] = useState(channel.parent_id || '');
  const [slowmode, setSlowmode] = useState(String(channel.slowmode || 0));
  const [previews, setPreviews] = useState(!channel.strip_embeds);
  const [expiry, setExpiry] = useState(
    channel.media_expiry_limit_secs == null ? '' : String(channel.media_expiry_limit_secs),
  );
  const [region, setRegion] = useState(channel.voice_region || '');
  const [bitrate, setBitrate] = useState(String(channel.bitrate || 64000));
  const [limit, setLimit] = useState(String(channel.user_limit || 0));
  const [busy, setBusy] = useState(false);
  const [regions, setRegions] = useState([]);

  const categories = store.channelsOf(guildId).filter((c) => c.type === 'category');

  useEffect(() => {
    if (!voice) return undefined;
    let live = true;
    store.apiForGuild(guildId).guildVoiceRegions(guildId)
      .then((data) => {
        if (!live) return;
        setRegions(data.regions || []);
      })
      .catch(() => { /* the Auto option alone is a working answer */ });
    return () => { live = false; };
  }, [store, guildId, voice]);

  const save = async () => {
    const body = {};
    const put = (key, next, was) => { if (next !== was) body[key] = next; };
    put('name', name.trim(), channel.name);
    if (!category) {
      put('topic', topic, channel.topic || '');
      put('parent_id', parent || null, channel.parent_id || null);
      put('slowmode', Number(slowmode), channel.slowmode || 0);
      put('strip_embeds', !previews, Boolean(channel.strip_embeds));
      put(
        'media_expiry_limit_secs',
        expiry.trim() === '' ? null : Number(expiry) || 0,
        channel.media_expiry_limit_secs ?? null,
      );
    }
    if (forum) {
      put('default_sort', sort, channel.default_sort || 'activity');
      put('default_layout', layout, channel.default_layout || 'list');
    }
    if (voice) {
      put('voice_region', region || null, channel.voice_region || null);
      put('bitrate', Number(bitrate), channel.bitrate || 64000);
      put('user_limit', Number(limit), channel.user_limit || 0);
    }
    if (!Object.keys(body).length) { close(); return; }
    setBusy(true);
    try {
      const saved = await store.apiForChannel(channel.id).patchChannel(channel.id, body);
      store.channels.set(channel.id, { ...channel, ...saved });
      store.emit('channels', guildId);
      close();
    } catch (e) {
      reportError(e, t(category ? 'channel.edit.saveFailedCategory' : 'channel.edit.saveFailed'));
    }
    finally { setBusy(false); }
  };

  const regionOptions = [
    ['', t('channel.voice.regionAutoDefault')],
    ...regions.map((r) => [
      r.name,
      r.guild ? t('channel.voice.regionCustom', { region: r.name }) : r.name,
    ]),
  ];

  return (
    <>
      <TextInput
        label={t('channel.field.name')}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
      />

      {category ? null : (
        <>
          <TextArea
            label={t('channel.field.topic')}
            hint={t('channel.edit.topicHint')}
            rows={2}
            value={topic}
            placeholder={voice
              ? t('channel.edit.topicPlaceholderVoice')
              : t('channel.edit.topicPlaceholder')}
            onChange={(e) => setTopic(e.target.value)}
          />

          {categories.length ? (
            <Select
              label={t('channel.field.category')}
              value={parent}
              options={[
                ['', t('channel.field.noCategory')],
                ...categories.map((c) => [c.id, c.name]),
              ]}
              onChange={(e) => setParent(e.target.value)}
            />
          ) : null}

          <Select
            label={voice ? t('channel.edit.slowmodeChatLabel') : t('channel.edit.slowmodeLabel')}
            hint={t('channel.edit.slowmodeHint')}
            value={slowmode}
            options={SLOWMODE.map(([secs, key, count]) => [String(secs), t(key, { count })])}
            onChange={(e) => setSlowmode(e.target.value)}
          />
        </>
      )}

      {forum ? (
        <>
          <Select
            label={t('channel.forum.sortLabel')}
            hint={t('channel.forum.sortHint')}
            value={sort}
            options={SORTS.map(([value, key]) => [value, t(key)])}
            onChange={(e) => setSort(e.target.value)}
          />
          <Select
            label={t('channel.forum.layoutLabel')}
            hint={t('channel.forum.layoutHint')}
            value={layout}
            options={LAYOUTS.map(([value, key]) => [value, t(key)])}
            onChange={(e) => setLayout(e.target.value)}
          />
        </>
      ) : null}

      {voice ? (
        <>
          <Select
            label={t('channel.voice.regionLabel')}
            hint={t('channel.voice.regionHint')}
            value={region}
            options={regionOptions}
            onChange={(e) => setRegion(e.target.value)}
          />
          <Select
            label={t('channel.voice.bitrateLabel')}
            hint={t('channel.voice.bitrateHint')}
            value={bitrate}
            options={BITRATES.map((b) => [String(b), t('channel.voice.bitrateValue', { kbps: b / 1000 })])}
            onChange={(e) => setBitrate(e.target.value)}
          />
          <Select
            label={t('channel.voice.limitLabel')}
            hint={t('channel.voice.limitHint')}
            value={limit}
            options={[0, 2, 3, 4, 5, 8, 10, 15, 20, 25, 50, 99].map((n) => [
              String(n),
              n ? t('channel.voice.limitPeople', { count: n }) : t('channel.voice.limitNone'),
            ])}
            onChange={(e) => setLimit(e.target.value)}
          />
        </>
      ) : null}

      {category ? null : (
        <>
          <Switch
            label={t('channel.edit.previewsLabel')}
            hint={t('channel.edit.previewsHint')}
            checked={previews}
            onChange={(next) => setPreviews(next)}
          />
          <TextInput
            label={t('channel.edit.expiryLabel')}
            hint={t('channel.edit.expiryHint')}
            value={expiry}
            placeholder={t('channel.edit.expiryPlaceholder')}
            onChange={(e) => setExpiry(e.target.value)}
          />
        </>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" onClick={close}>{t('common.cancel')}</Button>
        <Button variant="primary" isDisabled={busy || !name.trim()} onClick={save}>
          {t('channel.edit.save')}
        </Button>
      </div>
    </>
  );
}

function ForumTags({ channel, close }) {
  const store = useStore();
  const t = useT();
  const [tags, setTags] = useState(() => (channel.available_tags || []).map((tag) => ({ ...tag })));
  const [busy, setBusy] = useState(false);

  const edit = (i, patch) => setTags(
    (was) => was.map((tag, at) => (at === i ? { ...tag, ...patch } : tag)),
  );
  const remove = (i) => setTags((was) => was.filter((_, at) => at !== i));
  const add = () => setTags((was) => [...was, { name: '', emoji: '', moderated: false }]);

  const save = async () => {
    const cleaned = tags
      .map((tag) => ({
        id: tag.id,
        name: tag.name.trim(),
        emoji: tag.emoji?.trim() || null,
        moderated: Boolean(tag.moderated),
      }))
      .filter((tag) => tag.name);
    setBusy(true);
    try {
      const saved = await store.apiForChannel(channel.id)
        .patchChannel(channel.id, { available_tags: cleaned });
      store.channels.set(channel.id, { ...channel, ...saved });
      store.emit('channels', channel.guild_id);
      close();
    } catch (e) { reportError(e, t('channel.tags.saveFailed')); }
    finally { setBusy(false); }
  };

  return (
    <>
      <Hint>{t('channel.tags.limit', { max: MAX_TAGS, perPost: TAGS_PER_POST })}</Hint>

      {tags.length ? (
        <div className="flex flex-col gap-2">
          {tags.map((tag, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <div key={i} className="grid grid-cols-[84px_minmax(0,1fr)_auto] items-end gap-2 rounded-xl border border-border p-2.5 sm:flex">
              <TextInput
                aria-label={t('channel.tags.emojiLabel', { n: i + 1 })}
                placeholder={t('channel.tags.emojiPlaceholder')}
                value={tag.emoji || ''}
                onChange={(e) => edit(i, { emoji: e.target.value })}
                className="w-[84px] shrink-0"
              />
              <TextInput
                aria-label={t('channel.tags.nameLabel', { n: i + 1 })}
                placeholder={t('channel.tags.namePlaceholder')}
                value={tag.name}
                onChange={(e) => edit(i, { name: e.target.value })}
                className="min-w-0 flex-1"
              />
              <div className="col-span-2 sm:contents">
                <Switch
                  label={t('channel.tags.moderated')}
                  checked={Boolean(tag.moderated)}
                  onChange={(next) => edit(i, { moderated: next })}
                />
              </div>
              <IconButton
                title={tag.name.trim()
                  ? t('channel.tags.removeNamed', { name: tag.name })
                  : t('channel.tags.removeUnnamed')}
                className="shrink-0 hover:bg-danger/10 hover:text-danger"
                onClick={() => remove(i)}
              >
                <CloseIcon />
              </IconButton>
            </div>
          ))}
        </div>
      ) : (
        <Field label={t('channel.tags.fieldLabel')}>
          <p className="flex items-center gap-2 rounded-xl border border-dashed border-border px-3 py-4 text-sm text-muted">
            <TagIcon className="size-4" />
            {t('channel.tags.empty')}
          </p>
        </Field>
      )}

      <div className="flex items-center justify-between gap-2 pt-1">
        <Button variant="ghost" isDisabled={tags.length >= MAX_TAGS} onClick={add}>
          <PlusIcon className="size-4" />
          {t('channel.tags.add')}
        </Button>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={close}>{t('common.cancel')}</Button>
          <Button variant="primary" isDisabled={busy} onClick={save}>
            {t('channel.tags.save')}
          </Button>
        </div>
      </div>

      {tags.some((tag) => tag.moderated) ? (
        <Hint>{t('channel.tags.moderatedNote')}</Hint>
      ) : null}

      <div className="flex flex-wrap gap-1.5">
        {tags.filter((tag) => tag.name.trim()).map((tag, i) => (
          // eslint-disable-next-line react/no-array-index-key
          <span key={i} className="flex items-center gap-1 rounded-md bg-surface-secondary px-2 py-1 text-xs text-muted">
            {tag.emoji ? <EmojiText>{tag.emoji}</EmojiText> : null}
            <span><EmojiText>{tag.name}</EmojiText></span>
          </span>
        ))}
      </div>
    </>
  );
}

function Permissions({ channel }) {
  const store = useStore();
  const t = useT();
  const guildId = channel.guild_id;
  const everyoneId = guildId;
  const roles = store.roleList(guildId, { includeEveryone: true });

  const [roleId, setRoleId] = useState(everyoneId);
  const [state, setState] = useState({});
  const [busy, setBusy] = useState(false);

  useEffect(() => { store.loadRoles(guildId).catch(() => {}); }, [store, guildId]);

  const overwrite = (channel.permission_overwrites || [])
    .find((o) => (o.target_type || 'role') === 'role' && o.target_id === roleId);

  useEffect(() => {
    const next = {};
    const allow = toBits(overwrite?.allow);
    const deny = toBits(overwrite?.deny);
    for (const [name, bit] of PERMISSION_MASKS) {
      if (allow & bit) next[name] = 'allow';
      else if (deny & bit) next[name] = 'deny';
    }
    setState(next);
  }, [overwrite?.allow, overwrite?.deny, roleId]);

  const write = async (values) => {
    let allow = 0n;
    let deny = 0n;
    for (const [name, bit] of PERMISSION_MASKS) {
      if (values[name] === 'allow') allow |= bit;
      else if (values[name] === 'deny') deny |= bit;
    }
    setBusy(true);
    try {
      const saved = await store.apiForChannel(channel.id)
        .setOverwrite(channel.id, 'role', roleId, allow, deny);
      store.channels.set(channel.id, { ...channel, ...saved });
      store.emit('channels', guildId);
    } catch (e) { reportError(e, t('channel.perms.saveFailed')); }
    finally { setBusy(false); }
  };

  const shut = isPrivate(channel);

  const togglePrivate = async (next) => {
    const view = PERMISSION_MASKS.get('VIEW_CHANNEL');
    const current = (channel.permission_overwrites || [])
      .find((o) => (o.target_type || 'role') === 'role' && o.target_id === everyoneId);
    let allow = toBits(current?.allow);
    let deny = toBits(current?.deny);
    if (next) { deny |= view; allow &= ~view; } else { deny &= ~view; allow &= ~view; }
    setBusy(true);
    try {
      const saved = await store.apiForChannel(channel.id)
        .setOverwrite(channel.id, 'role', everyoneId, allow, deny);
      store.channels.set(channel.id, { ...channel, ...saved });
      store.emit('channels', guildId);
    } catch (e) { reportError(e, t('channel.perms.privateFailed')); }
    finally { setBusy(false); }
  };

  return (
    <>
      <Switch
        label={t('channel.perms.privateLabel')}
        hint={shut
          ? t('channel.perms.privateHintOn', { permission: permissionInfo('VIEW_CHANNEL').label })
          : t('channel.perms.privateHintOff')}
        checked={shut}
        disabled={busy}
        onChange={(next) => togglePrivate(next)}
      />
      {shut ? (
        <p className="flex items-center gap-1.5 text-xs text-muted">
          <LockIcon className="size-3.5 shrink-0" />
          {t('channel.perms.lockNote')}
        </p>
      ) : null}

      <Select
        label={t('channel.perms.roleLabel')}
        hint={t('channel.perms.roleHint')}
        value={roleId}
        options={roles.length
          ? roles.map((r) => [r.id, r.id === everyoneId ? '@everyone' : r.name])
          : [[everyoneId, '@everyone']]}
        onChange={(e) => setRoleId(e.target.value)}
      />

      <Hint>{t('channel.perms.triStateHint')}</Hint>

      <div className="flex flex-col gap-4">
        {groupsFor(channel.type).map(([titleKey, names]) => (
          <div key={titleKey} className="flex flex-col gap-1">
            <div className="eyebrow">{t(titleKey)}</div>
            <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
              {names.map((name) => {
                const info = permissionInfo(name);
                return (
                  <div key={name} className="flex items-center justify-between gap-4 px-3 py-2">
                    <span className="min-w-0 flex-1">
                      <span className="block text-base">{info.label}</span>
                      <span className="block text-xs leading-[1.5] text-muted">
                        {info.hint}
                      </span>
                    </span>
                    <TriState
                      name={info.label}
                      value={state[name] || 'inherit'}
                      disabled={busy}
                      onChange={(v) => {
                        const next = { ...state, [name]: v };
                        setState(next);
                        write(next);
                      }}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

const CHOICES = [
  ['deny', '✕', 'channel.perms.deny'],
  ['inherit', '/', 'channel.perms.inherit'],
  ['allow', '✓', 'channel.perms.allow'],
];

function TriState({ name, value, disabled, onChange }) {
  const t = useT();
  return (
    <div role="group" aria-label={name} className="flex shrink-0 overflow-hidden rounded-lg bg-surface-secondary shadow-[0_0_0_1px_var(--border)]">
      {CHOICES.map(([key, glyph, labelKey]) => {
        const on = value === key;
        const label = t(labelKey);
        return (
          <button
            key={key}
            type="button"
            disabled={disabled}
            aria-pressed={on}
            aria-label={t('channel.perms.choiceLabel', { choice: key, permission: name })}
            title={label}
            onClick={() => onChange(key)}
            className={[
              'flex size-10 items-center justify-center text-base transition-colors sm:size-7',
              on && key === 'deny' ? 'bg-danger text-danger-foreground' : '',
              on && key === 'allow' ? 'bg-success text-white' : '',
              on && key === 'inherit' ? 'bg-surface-tertiary text-foreground' : '',
              on ? '' : 'text-muted hover:bg-surface-secondary hover:text-foreground',
            ].filter(Boolean).join(' ')}
          >
            {glyph}
          </button>
        );
      })}
    </div>
  );
}
