export async function answerAndroidCallNotification(store, join, conversationId) {
  if (!conversationId || !store.signedIn) return false;

  const response = await store.voiceApi(conversationId)?.voiceStates(conversationId);
  const states = Array.isArray(response?.voice_states) ? response.voice_states : [];
  store.hydrateVoice(conversationId, states);

  const callerStillPresent = states.some(
    (state) => state?.user_id && state.user_id !== store.me?.user_id,
  );
  if (!callerStillPresent) return false;

  store.stopRing(conversationId, 'answered');
  await join(conversationId);
  return true;
}
