import { useEffect, useState } from 'react';
import { useStore } from '../../hooks/useStore.jsx';
import { reportError } from '../../hooks/useToast.jsx';
import { useT } from '../../lib/i18n/react.jsx';
import { PERMISSION_MASKS } from '../../lib/perms.js';
import {
  AnnouncementIcon, Button, Field, Flow, ForumIcon, HashIcon, ModalShell, Select,
  Switch, TextInput, TextSwap, VoiceIcon, Way, Ways,
} from '../../components/index.js';

const KINDS = {
  text: {
    icon: HashIcon,
    label: 'channel.type.text.name',
    description: 'channel.type.text.description',
    title: 'channel.create.newText',
  },
  voice: {
    icon: VoiceIcon,
    label: 'channel.type.voice.name',
    description: 'channel.type.voice.description',
    title: 'channel.create.newVoice',
  },
  forum: {
    icon: ForumIcon,
    label: 'channel.type.forum.name',
    description: 'channel.type.forum.description',
    title: 'channel.create.newForum',
  },
  announcement: {
    icon: AnnouncementIcon,
    label: 'channel.type.announcement.name',
    description: 'channel.type.announcement.description',
    title: 'channel.create.newAnnouncement',
  },
};

const DEPTH = { kind: 0, name: 1 };

export function CreateChannelDialog({ guild, close, parentId = '' }) {
  const store = useStore();
  const t = useT();
  const kinds = Object.keys(KINDS)
    .filter((key) => key !== 'voice' || store.supportsForGuild(guild.id, 'voice'));
  const categories = store.channelsOf(guild.id).filter((c) => c.type === 'category');

  const [step, setStep] = useState('kind');
  const [kind, setKind] = useState(kinds[0] || 'text');
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [parent, setParent] = useState(parentId);
  const [private_, setPrivate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [region, setRegion] = useState('');
  const [regions, setRegions] = useState([]);

  useEffect(() => {
    if (kind !== 'voice' || step !== 'name') return undefined;
    let alive = true;
    (async () => {
      try {
        const data = await store.apiForGuild(guild.id).guildVoiceRegions(guild.id);
        if (!alive) return;
        setRegions(data.regions || []);
        setRegion(data.guild_default || '');
      } catch {
        /* keep the default "Auto" option if the list can't be loaded */
      }
    })();
    return () => { alive = false; };
  }, [kind, step, guild.id]);

  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const api = store.apiForGuild(guild.id);
      const body = { name: name.trim(), type: kind };
      if (topic.trim()) body.topic = topic.trim();
      if (parent) body.parent_id = parent;
      if (kind === 'voice' && region) body.voice_region = region;
      const ch = await api.createChannel(guild.id, body);
      if (private_) {
        await api.setOverwrite(ch.id, 'role', guild.id, 0n, PERMISSION_MASKS.get('VIEW_CHANNEL'));
      }
      store.channels.set(ch.id, { ...ch, guild_id: guild.id, domain: guild.domain });
      store.emit('channels', guild.id);
      close();
    } catch (e) { reportError(e, t('channel.create.failed')); }
    finally { setBusy(false); }
  };

  const regionOptions = [
    ['', t('channel.voice.regionAuto')],
    ...regions.map((r) => [
      r.name,
      r.guild ? t('channel.voice.regionCustom', { region: r.name }) : r.name,
    ]),
  ];

  const titles = {
    kind: t('channel.create.title'),
    name: t(KINDS[kind]?.title || 'channel.create.newText'),
  };

  const body = step === 'kind' ? (
    <Ways>
      {kinds.map((key, at) => (
        <Way
          key={key}
          icon={KINDS[key].icon}
          tone={at === 0 ? 'accent' : undefined}
          name={t(KINDS[key].label)}
          description={t(KINDS[key].description)}
          onClick={() => { setKind(key); setStep('name'); }}
        />
      ))}
    </Ways>
  ) : (
    <form className="flex flex-col gap-3.5" onSubmit={(e) => { e.preventDefault(); create(); }}>
      <TextInput
        autoFocus
        label={t('channel.field.name')}
        value={name}
        placeholder={t('channel.create.namePlaceholder')}
        onChange={(e) => setName(e.target.value)}
      />
      <TextInput
        label={t('channel.field.topic')}
        value={topic}
        placeholder={t('common.optional')}
        onChange={(e) => setTopic(e.target.value)}
      />
      {categories.length ? (
        <Field label={t('channel.field.category')}>
          <Select
            value={parent}
            options={[
              ['', t('channel.field.noCategory')],
              ...categories.map((c) => [c.id, c.name]),
            ]}
            onChange={(e) => setParent(e.target.value)}
          />
        </Field>
      ) : null}
      {kind === 'voice' ? (
        <Field label={t('channel.field.region')}>
          <Select
            value={region}
            options={regionOptions}
            onChange={(e) => setRegion(e.target.value)}
          />
        </Field>
      ) : null}
      <Switch
        label={t('channel.field.private')}
        hint={t('channel.create.privateHint')}
        checked={private_}
        onChange={(next) => setPrivate(next)}
      />
      <Button
        type="submit"
        variant="primary"
        size="lg"
        loading={busy}
        isDisabled={!name.trim()}
        className="mt-1 w-full"
      >
        {t('channel.create.submit')}
      </Button>
    </form>
  );

  return (
    <ModalShell
      title={<TextSwap k={step}>{titles[step]}</TextSwap>}
      onBack={step === 'name' ? () => setStep('kind') : null}
      bodyClassName="pt-0 pb-5"
    >
      <Flow step={step} depth={DEPTH[step]} className="is-tight">{body}</Flow>
    </ModalShell>
  );
}
