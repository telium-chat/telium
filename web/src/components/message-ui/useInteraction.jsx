import { useCallback, useEffect, useReducer, useRef } from 'react';
import { useStore } from '../../hooks/useStore.jsx';
import { useModal } from '../../hooks/useModal.jsx';
import { reportError } from '../../hooks/useToast.jsx';
import {
  attachInteractions, awaitFollowUp, beginInteraction, deferInteraction, endInteraction,
  interactionPhase, postInteraction, postModalSubmit, subscribeInteractions,
  subscribeModalRequests, SILENCE_MS,
} from '../../lib/interactions.js';
import { ComponentModal } from './ComponentModal.jsx';

export function useInteractions(msg, { appName } = {}) {
  const store = useStore();
  const modal = useModal();
  const [, bump] = useReducer((n) => n + 1, 0);

  useEffect(() => subscribeInteractions(bump), []);
  useEffect(() => attachInteractions(store), [store]);

  const channelId = msg.channel_id;
  const messageId = msg.id;
  const ephemeral = Boolean(msg.ephemeral);

  const send = useCallback(async ({ customId, values }) => {
    const at = { channelId, messageId, customId };
    beginInteraction(messageId, customId);

    let resp;
    try {
      resp = await postInteraction(store.apiForChannel(channelId), {
        channelId, messageId, customId, values, ephemeral,
      });
    } catch (error) {
      endInteraction(messageId, customId);
      reportError(error, 'That did not reach the application');
      return null;
    }

    awaitFollowUp(resp?.id, at);
    deferInteraction(messageId, customId, { ttl: SILENCE_MS, phase: 'sending' });
    return resp;
  }, [store, channelId, messageId, ephemeral]);

  const submitRef = useRef(null);

  const submit = useCallback(async (request, fields) => {
    const customId = request.modal.customId;
    const at = { channelId, messageId, customId };
    beginInteraction(messageId, customId);

    let resp;
    try {
      resp = await postModalSubmit(store.apiForChannel(channelId), {
        interactionId: request.interactionId, fields,
      });
    } catch (error) {
      endInteraction(messageId, customId);
      reportError(error, 'That form did not reach the application');
      return null;
    }

    awaitFollowUp(resp?.id, at);
    deferInteraction(messageId, customId, { ttl: SILENCE_MS, phase: 'sending' });
    return resp;
  }, [store, channelId, messageId]);

  useEffect(() => { submitRef.current = submit; }, [submit]);

  useEffect(() => subscribeModalRequests((request) => {
    if (request.at?.messageId !== messageId) return;
    modal.open((close) => (
      <ComponentModal
        modal={request.modal}
        appName={appName}
        close={close}
        onSubmit={(fields) => submitRef.current?.(request, fields)}
      />
    ));
  }), [messageId, modal, appName]);

  return {
    send,
    phaseOf: (customId) => interactionPhase(messageId, customId),
  };
}
