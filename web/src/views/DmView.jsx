import { useCallback, useEffect, useState } from 'react';
import { useStore, useStoreEvent, useStoreEventFor } from '../hooks/useStore.jsx';
import { useConversationPeer } from '../hooks/useConversationPeer.js';
import { useModal } from '../hooks/useModal.jsx';
import { cn } from '../lib/cn.js';
import { conversationName } from '../lib/util.js';
import { useVoice } from '../hooks/useVoice.jsx';
import { useT } from '../lib/i18n/react.jsx';
import {
  Avatar, EmojiText, IconButton, InfoIcon, LockIcon, MembersIcon, PhoneIcon, PhoneOffIcon, PinIcon,
  UserIcon,
} from '../components/index.js';
import { MobileTopbar, MobileTopbarButton } from './mobile/MobileNavigation.jsx';
import { CallStage } from './CallStage.jsx';
import { Conversation, ConversationStart } from './chat/Conversation.jsx';
import {
  hasUnavailableDmHistory, useDmItems, useDmSurface,
} from './chat/surface.jsx';
import {
  ConversationNotices, EncryptionChip, NOT_YET_READABLE, useDeviceTrust,
} from './chat/encryption.jsx';
import { ConversationDialog } from './dialogs/ConversationDialog.jsx';
import { PinsButton, PinsDialog } from './dialogs/PinsDialog.jsx';
import { DmHeaderSearch } from './search.jsx';
import { DmSidePanel, dmPanelShown } from './DmSidePanel.jsx';

export function DmView({ conversationId, mobile = false, onBack, onMore, onOpenNavigation }) {
  const store = useStore();
  useStoreEventFor(
    (e) => !e?.conversation_id || e.conversation_id === conversationId,
    'dm',
  );
  useStoreEvent('conversations', 'vault', 'voice', 'prefs', 'ring', 'call-log');
  const modal = useModal();
  const voice = useVoice();
  const t = useT();

  const [opened, setOpened] = useState(null);
  const [error, setError] = useState(null);
  const convo = (opened?.id === conversationId ? opened.convo : null)
    || store.dmOpened.get(conversationId)
    || store.conversations.find((c) => c.id === conversationId)
    || null;
  const loading = Boolean(conversationId) && !store.dmOpened.has(conversationId) && !error;
  const [reload, setReload] = useState(0);

  const trustRows = useDeviceTrust(conversationId);
  const unverified = trustRows.filter((d) => d.status !== 'verified').length;
  const changedKey = Boolean(store.trust?.identityMismatch)
    || trustRows.some((d) => d.status === 'changed' || d.status === 'revoked');

  useEffect(() => {
    if (!conversationId) return undefined;
    let live = true;
    setError(null);
    store.openConversation(conversationId)
      .then((c) => { if (live) setOpened({ id: conversationId, convo: c }); })
      .catch((e) => { if (live) setError(e); });
    return () => { live = false; };
  }, [store, conversationId, reload]);

  useEffect(() => {
    if (!conversationId) return undefined;
    let live = true;
    store.voiceApi(conversationId)?.voiceStates(conversationId)
      .then((resp) => {
        if (!live) return;
        store.hydrateVoice(conversationId, resp.voice_states || []);
      })
      .catch(() => {});
    return () => { live = false; };
  }, [store, conversationId]);

  const surface = useDmSurface(convo);
  const frames = store.dmFrames.get(conversationId) || [];
  const callLogs = store.callLogs.get(conversationId) || [];
  const items = useDmItems(frames, convo, store.mls, store.me?.user_id, callLogs);

  const settled = store.dmOpened.has(conversationId);
  const awaiting = settled && Boolean(store.mls) && Boolean(conversationId)
    && !store.mls.joined(conversationId);
  const unavailable = settled && hasUnavailableDmHistory(
    frames, conversationId, store.mls,
  );
  const syncError = (settled && store.mls?.errorFor?.(conversationId)) || null;

  const unseenPins = store.unseenPinCount(null, conversationId);

  useEffect(() => {
    if (!conversationId) return undefined;
    const seen = () => { if (document.hasFocus()) store.markConversationRead(conversationId); };
    seen();
    window.addEventListener('focus', seen);
    return () => window.removeEventListener('focus', seen);
  }, [store, conversationId, frames.length]);

  useEffect(() => {
    if (!conversationId) return undefined;
    return () => { store.closeConversation(conversationId); };
  }, [store, conversationId]);

  const send = useCallback(async (body, content, nonce) => {
    const quoted = body?.reply_to ? items.find((m) => m.id === body.reply_to) : null;
    return store.sendDm(
      conversationId,
      content,
      body?.attachments || [],
      quoted ? { id: quoted.id, author: quoted.author, text: quoted.content || '' } : null,
      nonce,
    );
  }, [store, conversationId, items]);

  const known = convo;
  const { faces, peer, title: withWhom, typing } = useConversationPeer(known);

  const openPins = () => modal.open((close) => (
    <PinsDialog conversationId={conversationId} close={close} />
  ));

  const openDetails = () => modal.open((close) => (
    <ConversationDialog convo={convo} close={close} refresh={() => setReload((n) => n + 1)} />
  ));

  const inCall = store.voice.get(conversationId) || [];
  const onCall = voice.channelId === conversationId;
  const calling = inCall.length > 0 || onCall;
  const me = store.me?.user_id;
  const othersInCall = inCall.filter((v) => v.user_id !== me);
  const ringingOut = Boolean(
    onCall && store.outgoingCalls.get(conversationId) && othersInCall.length === 0,
  );
  const title = known?.kind === 'gc'
    ? conversationName(known, store.me?.user_id)
    : withWhom;

  const mobileActions = convo ? (
    <div className="flex items-center gap-0.5">
      <MobileTopbarButton
        label={onCall ? 'Leave call' : inCall.length ? 'Join call' : 'Start a call'}
        className={onCall ? 'text-danger' : undefined}
        onClick={() => (onCall ? voice.leave(conversationId) : voice.join(conversationId))}
      >
        {onCall ? <PhoneOffIcon className="size-5" /> : <PhoneIcon className="size-5" />}
      </MobileTopbarButton>
      <MobileTopbarButton
        label="Pinned messages"
        onClick={openPins}
        badge={unseenPins ? String(unseenPins) : null}
      >
        <PinIcon className="size-5" />
      </MobileTopbarButton>
    </div>
  ) : null;

  const panelShown = !mobile && dmPanelShown(store);
  const panelTitle = known?.kind === 'gc'
    ? (panelShown ? 'Hide member list' : 'Show member list')
    : (panelShown ? 'Hide profile' : 'Show profile');

  const view = (
    <div className={`dm-view flex min-w-0 min-h-0 flex-1 flex-col overflow-hidden${mobile ? ' page-in' : ''}`}>
      {mobile ? (
        <MobileTopbar
          title={title}
          subtitle="Direct message"
          onBack={onBack}
          onMore={onMore}
          actions={mobileActions}
        />
      ) : (
        <header className="topbar flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
          <h1 className="shrink-0 truncate text-base font-semibold tracking-tight"><EmojiText>{title}</EmojiText></h1>
          {convo ? (
            <>
              <span className="h-4 w-px shrink-0 bg-border" />
              <EncryptionChip
                custody={store.custody?.mode}
                unverified={changedKey ? 0 : unverified}
                changed={changedKey}
                typing={store.typingSignalsIn(conversationId)}
                onOpen={openDetails}
              />
            </>
          ) : null}
          <div className="flex-1" />
          {convo ? (
            <div className="flex shrink-0 items-center gap-0.5">
              <IconButton
                title={onCall ? 'Leave call' : inCall.length ? 'Join call' : 'Start a call'}
                className={onCall ? 'text-danger' : undefined}
                onClick={() => (onCall ? voice.leave(conversationId) : voice.join(conversationId))}
              >
                {onCall ? <PhoneOffIcon /> : <PhoneIcon />}
              </IconButton>
              <PinsButton conversationId={conversationId} />
              <IconButton title="Conversation details" onClick={openDetails}>
                <InfoIcon />
              </IconButton>
              <span className="hidden xl:contents">
                <IconButton
                  active={panelShown}
                  title={panelTitle}
                  onClick={() => {
                    store.prefs.dmPanel = !panelShown;
                    store.savePrefs();
                  }}
                >
                  {known?.kind === 'gc' ? <MembersIcon /> : <UserIcon />}
                </IconButton>
              </span>
            </div>
          ) : null}
          {convo ? <DmHeaderSearch conversationId={conversationId} convo={convo} /> : null}
        </header>
      )}

      <Conversation
        surface={surface}
        items={items}
        typing={typing}
        loading={loading}
        error={error}
        notices={(
          <div className="pt-2">
            <ConversationNotices
              store={store}
              conversationId={conversationId}
              awaiting={awaiting}
              changedKey={changedKey}
              syncError={syncError}
              onRetry={() => setReload((n) => n + 1)}
            />
            {unavailable && !awaiting && !syncError ? (
              <p className="flex items-start gap-1.5 px-2 py-1 text-xs leading-[1.5] text-muted">
                <LockIcon className="mt-[3px] size-3 shrink-0" />
                {NOT_YET_READABLE}
              </p>
            ) : null}
          </div>
        )}
        intro={<DmIntro convo={convo} faces={faces} withWhom={withWhom} />}
        send={convo ? send : null}
        mobile={mobile}
        onOpenNavigation={onOpenNavigation}
        above={calling ? (
          <div className={cn(
            'flex flex-col border-b border-border bg-strip',
            mobile ? 'min-h-[190px] flex-1' : 'min-h-[240px] flex-[1.2]',
          )}>
            {ringingOut ? (
              <div
                role="status"
                className="flex shrink-0 items-center gap-2.5 border-b border-border bg-surface px-4 py-2.5"
              >
                <span className="relative flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-accent-foreground">
                  <PhoneIcon className="size-4 animate-pulse" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">
                    {t('voice.log.ringing')}
                  </span>
                  <span className="block truncate text-xs text-muted">
                    {t('voice.log.ringingHint')}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => voice.leave(conversationId)}
                  className="flex shrink-0 items-center gap-1.5 rounded-full bg-danger px-3.5 py-1.5 text-sm font-semibold text-danger-foreground transition-opacity hover:opacity-90"
                >
                  <PhoneOffIcon className="size-4" />
                  {t('voice.log.cancel')}
                </button>
              </div>
            ) : null}
            <CallStage
              roomId={conversationId}
              participants={inCall}
              emptyTitle="Nobody is in this call"
              emptyBody="Join to open it."
              joinLabel="Join call"
              joinHint="Opens your microphone."
              staleHint="Nothing on this tab is connected. Rejoin, or disconnect to clear it."
              mobile={mobile}
            />
          </div>
        ) : null}
      />
    </div>
  );

  if (!panelShown) return view;
  return (
    <div className="flex min-w-0 min-h-0 flex-1">
      {view}
      <DmSidePanel convo={known} />
    </div>
  );
}

function DmIntro({ convo, faces, withWhom }) {
  if (!convo) return null;
  const group = convo.kind === 'gc';
  return (
    <ConversationStart
      mark={(
        <div className="flex -space-x-2">
          {faces.slice(0, 4).map((face) => (
            <Avatar
              key={face.id}
              id={face.id}
              name={face.name}
              size="lg"
              mediaRef={face.avatarRef}
              base={face.base}
              mediaOrigin={face.mediaOrigin}
              className="ring-2 ring-background"
            />
          ))}
        </div>
      )}
      title={group ? `Group · ${faces.length + 1} people` : withWhom}
      blurb={group
        ? 'The start of this group conversation.'
        : `The start of your messages with ${withWhom}.`}
    />
  );
}
