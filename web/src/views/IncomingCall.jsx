import { useStore, useStoreEvent } from '../hooks/useStore.jsx';
import { useVoice } from '../hooks/useVoice.jsx';
import { reportError } from '../hooks/useToast.jsx';
import { useT } from '../lib/i18n/react.jsx';
import { faceOf } from '../lib/faces.js';
import { shortName } from '../lib/util.js';
import { Avatar, Button, EmojiText, PhoneIcon, PhoneOffIcon } from '../components/index.js';

function RingingCall({ ring }) {
  const t = useT();
  const store = useStore();
  const voice = useVoice();
  const { conversationId, from } = ring;

  const face = faceOf(store, from);
  const named = face?.name || shortName(from) || null;
  const namedArm = named ? 'yes' : 'no';
  const convo = store.conversations.find((c) => c.id === conversationId);
  const group = convo && (convo.kind === 'gc' || convo.name);
  const where = group
    ? (convo.name || t('voice.incoming.groupSize', { count: (convo.members || []).length }))
    : t('voice.incoming.title');

  const answer = () => {
    store.stopRing(conversationId, 'answered');
    store.navigate({
      view: 'dms', guildId: null, channelId: null, conversationId,
    });
    voice.join(conversationId)?.catch?.((e) => reportError(e, t('voice.incoming.joinFailed')));
  };

  return (
    <div
      className="ringing-call rise-in flex w-[320px] max-w-full items-center gap-3 bg-surface p-3"
      role="group"
      aria-label={t('voice.incoming.fromWho', { named: namedArm, caller: named })}
    >
      <span className="ringing-call__face shrink-0">
        <Avatar
          id={from}
          name={face?.name}
          size="lg"
          mediaRef={face?.avatarRef}
          base={face?.base}
          mediaOrigin={face?.mediaOrigin}
        />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-base font-semibold tracking-tight">
          <EmojiText>{named || t('voice.incoming.title')}</EmojiText>
        </div>
        {named || group ? (
          <div className="truncate text-sm text-muted">
            <EmojiText>{where}</EmojiText>
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          variant="danger-soft"
          shape="circle"
          aria-label={t('voice.incoming.decline', { named: namedArm, caller: named })}
          onClick={() => store.declineCall(conversationId)}
        >
          <PhoneOffIcon className="size-[18px]" />
        </Button>
        <Button
          variant="primary"
          shape="circle"
          aria-label={t('voice.incoming.answer', { named: namedArm, caller: named })}
          onClick={answer}
        >
          <PhoneIcon className="size-[18px]" />
        </Button>
      </div>
    </div>
  );
}

export function IncomingCallHost() {
  const store = useStore();
  useStoreEvent('ring');
  const rings = [...store.ringing.values()];
  return (
    <>
      <div className="sr-only" role="alert" aria-live="assertive" aria-atomic="true">
        {rings.map((ring) => {
          const face = faceOf(store, ring.from);
          const caller = face?.name || shortName(ring.from) || 'Someone';
          return <p key={ring.conversationId}>{`Incoming call from ${caller}. Tab to answer or decline.`}</p>;
        })}
      </div>
      {rings.length ? (
        <div className="ringing-calls">
          {rings.map((ring) => <RingingCall key={ring.conversationId} ring={ring} />)}
        </div>
      ) : null}
    </>
  );
}
