import { test, expect } from '@playwright/test';

test('real Chromium negotiates fixed media lines through glare and simultaneous ICE restarts', async ({ page }) => {
  // The app shell supplies Vite's ESM modules; calls use real browser
  // RTCPeerConnections but an in-page signaling relay (no homeserver needed).
  await page.goto('http://127.0.0.1:5173');
  const result = await page.evaluate(async () => {
    const { MeshCall } = await import('/src/lib/voice-mesh.js');
    const names = ['@alice:test', '@bob:test'];
    const peers = {};
    const errors = [];
    const offers = [];
    const fail = (error) => errors.push(error?.message || String(error));
    const until = async (predicate) => {
      for (let i = 0; i < 100; i += 1) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error('WebRTC negotiation did not reach the expected state');
    };
    // A missing microphone is permitted in a receive-only call. Avoid a
    // permissions prompt so this test works on headless CI runners.
    const original = navigator.mediaDevices.getUserMedia;
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException('test has no microphone', 'NotAllowedError');
    };
    try {
      for (const from of names) {
        peers[from] = new MeshCall({
          me: from,
          signal: async (target, payload) => {
            if (payload.description?.type === 'offer') offers.push([from, payload.offerId]);
            await peers[target].accept({ from, payload });
          },
          onError: fail,
        });
        await peers[from].start([]);
      }
      for (const from of names) peers[from].sync(names);
      const connection = (from, to) => peers[from].peers.get(to).pc;
      const settled = () => names.every((from, i) => {
        const pc = connection(from, names[1 - i]);
        return pc.signalingState === 'stable'
          && pc.localDescription?.sdp && pc.remoteDescription?.sdp;
      });
      await until(settled);
      const mediaLines = (description) => description.sdp.split(/\r?\n/)
        .filter((line) => line.startsWith('m=')).map((line) => line.split(' ')[0]);
      const baseline = mediaLines(connection(names[0], names[1]).localDescription);
      if (baseline.length !== 4) throw new Error('Expected four negotiated m-lines');
      for (let i = 0; i < names.length; i += 1) {
        const pc = connection(names[i], names[1 - i]);
        if (pc.getTransceivers().length !== 4) {
          throw new Error('Duplicate internal transceivers on participant ' + names[i]);
        }
      }

      for (let round = 0; round < 3; round += 1) {
        const count = offers.length;
        for (let i = 0; i < names.length; i += 1) {
          connection(names[i], names[1 - i]).restartIce();
        }
        await until(() => offers.length > count && settled());
        // Allow the second simultaneous offer and its answer to settle too.
        await new Promise((resolve) => setTimeout(resolve, 80));
        await until(settled);
        for (let i = 0; i < names.length; i += 1) {
          const pc = connection(names[i], names[1 - i]);
          if (pc.getTransceivers().length !== 4) {
            throw new Error('ICE restart duplicated internal transceivers');
          }
          const actual = mediaLines(pc.localDescription);
          if (actual.join('|') !== baseline.join('|')) {
            throw new Error('m-line layout changed: ' + actual.join(', '));
          }
        }
      }
      // An old answer after stable must not cause a browser InvalidStateError.
      await peers[names[0]].accept({ from: names[1], payload: {
        session: peers[names[1]].sessionId,
        targetSession: peers[names[0]].sessionId,
        answerTo: 'superseded',
        description: { type: 'answer', sdp: 'obsolete' },
      } });
      return { errors, lines: baseline, rounds: 3 };
    } finally {
      for (const peer of Object.values(peers)) peer.stop();
      navigator.mediaDevices.getUserMedia = original;
    }
  });
  expect(result.errors).toEqual([]);
  expect(result.lines).toHaveLength(4);
  expect(result.rounds).toBe(3);
});
