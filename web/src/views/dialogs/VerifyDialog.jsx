import { useEffect, useRef, useState } from 'react';
import { useStore, useStoreEvent } from '../../hooks/useStore.jsx';
import { toast } from '../../hooks/useToast.jsx';
import { codeOf, errorMessage } from '../../lib/i18n/errors.js';
import { useT } from '../../lib/i18n/react.jsx';
import { shortName } from '../../lib/util.js';
import { Button, Hint, Loading, ModalShell, Notice, Spinner } from '../../components/index.js';

export function useVerificationLifetime(store, exchange) {
  const cleanupGeneration = useRef(0);
  useEffect(() => {
    const generation = ++cleanupGeneration.current;
    return () => {
      const txn = exchange?.txn;
      if (!txn) return;
      queueMicrotask(() => {
        if (cleanupGeneration.current === generation) store.endVerification(txn);
      });
    };
  }, [store, exchange]);
}

export function VerifyDialog({ exchange: inbound = null, userId, deviceId = null, close }) {
  const store = useStore();
  const t = useT();
  const [exchange, setExchange] = useState(inbound);
  const [error, setError] = useState(null);
  const [sent, setSent] = useState(false);
  const [refused, setRefused] = useState(false);
  const started = useRef(false);
  useStoreEvent('verify');

  useEffect(() => {
    if (inbound || started.current) return;
    started.current = true;
    store.startVerification(userId, deviceId).then(setExchange).catch(setError);
  }, [store, inbound, userId, deviceId]);

  useVerificationLifetime(store, exchange);

  const peer = exchange?.peerUser || userId;
  const self = peer === store.me?.user_id;
  const name = self ? null : shortName(peer);
  const title = self ? t('security.verify.titleSelf') : t('security.verify.titlePeer', { name });

  const confirm = async () => {
    setSent(true);
    try { await exchange.confirm(); }
    catch (e) {
      setSent(false);
      toast(
        codeOf(e) ? errorMessage(e) : t('security.verify.finishFailed', { reason: errorMessage(e) }),
        { error: true },
      );
    }
  };

  const reject = () => {
    setRefused(true);
    exchange.cancel('the emoji did not match');
  };

  const state = exchange?.state;
  const settled = state === 'done' || state === 'cancelled';
  const waiting = !settled && (sent || state === 'waiting');

  return (
    <ModalShell
      title={title}
      footer={(
        <>
          {waiting ? (
            <>
              <Button variant="ghost" onClick={close}>{t('common.cancel')}</Button>
              <Button variant="primary" disabled className="gap-2">
                <Spinner className="opacity-100" />
                {t('security.verify.waitingButton')}
              </Button>
            </>
          ) : state === 'compare' ? (
            <>
              <Button variant="danger-soft" onClick={reject}>{t('security.verify.noMatch')}</Button>
              <Button variant="primary" onClick={confirm}>{t('security.verify.match')}</Button>
            </>
          ) : (
            <Button variant="ghost" onClick={close}>
              {state === 'done' ? t('common.done') : t('common.cancel')}
            </Button>
          )}
        </>
      )}
    >
      {error ? (
        <Notice tone="danger">
          {codeOf(error)
            ? errorMessage(error)
            : t('security.verify.startFailed', { reason: errorMessage(error) })}
        </Notice>
      ) : null}
      {!exchange && !error ? <Loading label={t('security.verify.starting')} /> : null}

      {state === 'pending' ? (
        <>
          <Loading label={self
            ? t('security.verify.waitingSelf')
            : t('security.verify.waitingPeer', { name })}
          />
          <Hint>
            {self
              ? t('security.verify.pendingHintSelf')
              : t('security.verify.pendingHintPeer')}
          </Hint>
        </>
      ) : null}

      {state === 'compare' && !waiting ? (
        <>
          <p className="text-sm leading-[1.6]">
            {self
              ? t('security.verify.compareSelf', { count: exchange.emoji.length })
              : t('security.verify.comparePeer', { name })}
          </p>
          <div className="vfy-grid">
            {exchange.emoji.map(([glyph, emojiName], i) => (
              // Same picture can repeat; position is the identity.
              // eslint-disable-next-line react/no-array-index-key
              <div key={i} className="vfy-tile">
                <span className="vfy-tile__glyph">{glyph}</span>
                <span className="vfy-tile__name">{emojiName}</span>
              </div>
            ))}
          </div>
          <Hint>{t('security.verify.mismatchHint')}</Hint>
        </>
      ) : null}

      {waiting ? (
        <Loading label={self
          ? t('security.verify.confirmingSelf')
          : t('security.verify.confirmingPeer', { name })}
        />
      ) : null}

      {state === 'done' ? (
        <Notice tone="success">
          {self
            ? t('security.verify.doneSelf')
            : t('security.verify.donePeer', { name })}
        </Notice>
      ) : null}

      {state === 'cancelled' ? (
        <Notice tone="warn">
          {refused
            ? t('security.verify.stoppedByYou')
            : t('security.verify.stopped', { reason: exchange.reason })}
        </Notice>
      ) : null}
    </ModalShell>
  );
}
