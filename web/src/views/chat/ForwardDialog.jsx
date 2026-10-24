import { useState } from 'react';
import { useStore } from '../../hooks/useStore.jsx';
import { reportError } from '../../hooks/useToast.jsx';
import { fetchEncrypted, uploadEncrypted } from '../../lib/upload.js';
import { forwardLine, takeForwards } from '../../lib/markdown.jsx';
import { has } from '../../lib/perms.js';
import { shortName } from '../../lib/util.js';
import { useT } from '../../lib/i18n/react.jsx';
import { teliumFetch } from '../../lib/net/transport.js';
import {
  Button, EmojiText, Field, HashIcon, ModalShell, Pill, ProgressBar, TextInput
} from '../../components/index.js';

function destinations(store, t) {
  const out = [];
  for (const guild of store.guilds.values()) {
    for (const ch of store.channelsOf(guild.id)) {
      if (ch.type !== 'text') continue;
      if (!has(store.permissionsIn(ch.id), 'SEND_MESSAGES')) continue;
      out.push({
        key: `channel:${ch.id}`,
        kind: 'channel',
        id: ch.id,
        domain: guild.domain,
        label: `#${ch.name}`,
        where: guild.name,
      });
    }
  }
  for (const convo of store.conversations) {
    const others = (convo.members || [])
      .map((m) => m.user_id || m)
      .filter((id) => id && id !== store.me?.user_id);
    const label = convo.kind === 'gc'
      ? t('common.convo.group', { count: others.length + 1 })
      : shortName(others[0] || '');
    out.push({
      key: `convo:${convo.id}`,
      kind: 'conversation',
      id: convo.id,
      label,
      where: convo.kind === 'gc'
        ? t('chat.forward.groupChat')
        : t('chat.forward.directMessage'),
    });
  }
  return out;
}

export function ForwardDialog({ payload, close, shared = false }) {
  const store = useStore();
  const t = useT();
  const [query, setQuery] = useState('');
  const [busyWith, setBusyWith] = useState(null);
  const [uploadProgress, setUploadProgress] = useState(0);

  const rehost = async () => {
    const out = [];
    for (const att of payload.attachments || []) {
      const blob = att.key
        ? await fetchEncrypted(store.home.base, att)
        : await teliumFetch(att.url, {}, { purpose: 'forward attachment' }).then((r) => r.blob());
      const file = new File([blob], att.name || 'attachment', {
        type: att.mime || 'application/octet-stream',
      });
      out.push(await uploadEncrypted(store.home, file, {
        onProgress: (loaded, total) => setUploadProgress(
          total ? Math.round((loaded / total) * 100) : 0,
        ),
      }));
    }
    return out;
  };

  const forwardTo = async (dest) => {
    setBusyWith(dest.key);
    setUploadProgress(0);
    try {
      const content = shared
        ? String(payload.text || '')
        : (() => {
          const body = takeForwards(payload.text).body;
          return body ? `${forwardLine(payload.origin)}\n${body}` : forwardLine(payload.origin);
        })();
      if (dest.kind === 'conversation') {
        const attachments = await rehost();
        await store.sendDm(dest.id, content, attachments);
      } else {
        await store.apiForChannel(dest.id)
          .send(dest.id, { content, attachments: payload.attachments || [] });
      }
      close();
    } catch (e) {
      reportError(e, shared ? t('chat.forward.shareFailed') : t('chat.forward.failed'));
    } finally {
      setBusyWith(null);
    }
  };

  const needle = query.trim().toLowerCase();
  const all = destinations(store, t);
  const hits = needle
    ? all.filter((d) => `${d.label} ${d.where}`.toLowerCase().includes(needle))
  : all;
  const busyTarget = all.find((d) => d.key === busyWith);

  return (
    <ModalShell
      title={shared ? t('chat.forward.shareTitle') : t('chat.forward.title')}
      footer={<Button variant="ghost" onClick={close}>{t('common.close')}</Button>}
    >
      <Field>
        <TextInput
          value={query}
          placeholder={t('chat.forward.search')}
          onChange={(e) => setQuery(e.target.value)}
        />
      </Field>
      {busyTarget?.kind === 'conversation' && payload.attachments?.length ? (
        <ProgressBar value={uploadProgress} />
      ) : null}
      <div className="flex max-h-[50vh] flex-col gap-px overflow-y-auto">
        {hits.map((d) => (
          <div key={d.key} className="flex items-center gap-2 rounded-lg px-2 py-1.5">
            <span className="min-w-0 flex-1 truncate text-base"><EmojiText>{d.label}</EmojiText></span>
            <Pill>{d.where}</Pill>
            <Button
              variant="secondary"
              disabled={busyWith === d.key}
              onClick={() => forwardTo(d)}
            >
              {busyWith === d.key ? t('chat.forward.sending') : t('chat.forward.send')}
            </Button>
          </div>
        ))}
        {!hits.length ? (
          <p className="py-6 text-center text-sm text-muted">
            {t('chat.forward.noMatches', { query })}
          </p>
        ) : null}
      </div>
    </ModalShell>
  );
}
