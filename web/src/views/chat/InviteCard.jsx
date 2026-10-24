import { useEffect, useState } from 'react';
import { useStore } from '../../hooks/useStore.jsx';
import { useModal } from '../../hooks/useModal.jsx';
import { useT } from '../../lib/i18n/react.jsx';
import { linksIn } from '../../lib/embeds.js';
import { joinInvite } from '../dialogs/AddGuildDialog.jsx';
import { Avatar, Button, EmojiText } from '../../components/index.js';

const INVITE = /\/invite\/~?[A-Za-z0-9]+/i;

export function isInviteUrl(url) {
  return INVITE.test(url);
}

export function invitesIn(content) {
  return linksIn(content).filter(isInviteUrl);
}

export function InviteCards({ urls }) {
  if (!urls?.length) return null;
  return (
    <div className="flex flex-col gap-1.5 pt-1.5">
      {urls.map((url) => <InviteCard key={url} url={url} />)}
    </div>
  );
}

export function InviteCard({ url }) {
  const t = useT();
  const store = useStore();
  const modal = useModal();
  const [preview, setPreview] = useState(null);

  useEffect(() => {
    let live = true;
    setPreview(null);
    store.previewInvite(url)
      .then((p) => { if (live) setPreview(p || 'unknown'); })
      .catch(() => { if (live) setPreview('unknown'); });
    return () => { live = false; };
  }, [store, url]);

  if (!preview || preview === 'unknown') {
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer noopener"
        className="block max-w-[440px] text-sm break-all text-accent underline underline-offset-2"
      >
        {url}
      </a>
    );
  }

  const guild = preview.guild || {};
  const count = guild.member_count ?? 0;
  return (
    <div className="invite-card embed embed--row">
      <Avatar id={guild.id} name={guild.name} mediaRef={guild.icon_ref} base={preview.base} />
      <div className="min-w-[10rem] flex-1 basis-40">
        <div className="text-sm font-medium break-words"><EmojiText>{guild.name}</EmojiText></div>
        <div className="text-xs text-muted break-words">
          {preview.domain
            ? t('chat.invite.membersOnHost', { count, domain: preview.domain })
            : t('chat.invite.members', { count })}
        </div>
      </div>
      <Button
        variant="primary"
        onClick={() => joinInvite(store, modal, preview.code, url, preview.domain)}
      >
        {guild.name ? t('chat.invite.join', { guild: guild.name }) : t('chat.invite.joinUnnamed')}
      </Button>
    </div>
  );
}
