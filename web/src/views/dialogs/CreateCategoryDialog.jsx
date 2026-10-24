import { useState } from 'react';
import { useStore } from '../../hooks/useStore.jsx';
import { reportError } from '../../hooks/useToast.jsx';
import { useT } from '../../lib/i18n/react.jsx';
import { PERMISSION_MASKS } from '../../lib/perms.js';
import { Button, ModalShell, Switch, TextInput } from '../../components/index.js';

export function CreateCategoryDialog({ guild, close }) {
  const store = useStore();
  const t = useT();
  const [name, setName] = useState('');
  const [private_, setPrivate] = useState(false);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const api = store.apiForGuild(guild.id);
      const ch = await api.createChannel(guild.id, { name: name.trim(), type: 'category' });
      if (private_) {
        await api.setOverwrite(ch.id, 'role', guild.id, 0n, PERMISSION_MASKS.get('VIEW_CHANNEL'));
      }
      store.channels.set(ch.id, { ...ch, guild_id: guild.id, domain: guild.domain });
      store.emit('channels', guild.id);
      close();
    } catch (e) { reportError(e, t('channel.createCategory.failed')); }
    finally { setBusy(false); }
  };

  return (
    <ModalShell title={t('channel.createCategory.title')} bodyClassName="pt-0 pb-5">
      <form className="flex flex-col gap-3.5" onSubmit={(e) => { e.preventDefault(); create(); }}>
        <TextInput
          autoFocus
          label={t('channel.field.name')}
          value={name}
          placeholder={t('channel.createCategory.namePlaceholder')}
          onChange={(e) => setName(e.target.value)}
        />
        <Switch
          label={t('channel.field.private')}
          hint={t('channel.createCategory.privateHint')}
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
          {t('channel.createCategory.submit')}
        </Button>
      </form>
    </ModalShell>
  );
}
