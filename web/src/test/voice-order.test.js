import { describe, expect, it } from 'vitest';
import { orderParticipants, VoiceRooms } from '../lib/voice-order.js';
import { freshStore } from './fake-server.js';

const v = (user_id, joined_at, extra = {}) => ({ user_id, channel_id: 'room', joined_at, ...extra });
const ids = (list) => list.map((x) => x.user_id);

describe('call participant order', () => {
  it('is the order people joined, whatever order the server listed them in', () => {
    expect(ids(orderParticipants([v('c', 30), v('a', 10), v('b', 20)]))).toEqual(['a', 'b', 'c']);
  });

  it('breaks a tie by id so every client agrees', () => {
    expect(ids(orderParticipants([v('b', 5), v('a', 5)]))).toEqual(['a', 'b']);
  });

  it('puts a state without a join time after the ones that have one', () => {
    expect(ids(orderParticipants([v('x', undefined), v('a', 10)]))).toEqual(['a', 'x']);
  });

  it('is applied on every write to store.voice, so a refetch cannot shuffle a live call', () => {
    const rooms = new VoiceRooms();
    rooms.set('room', [v('a', 10), v('b', 20), v('c', 30)]);
    // The server's refetch comes back in a different order.
    rooms.set('room', [v('c', 30), v('a', 10), v('b', 20)]);
    expect(ids(rooms.get('room'))).toEqual(['a', 'b', 'c']);
  });

  it('keeps the order when a live update arrives for someone in the room', () => {
    const store = freshStore();
    store.voice.set('room', [v('a', 10), v('b', 20), v('c', 30)]);
    store.onVoice({ user_id: 'a', channel_id: 'room', self_mute: true });
    store.onVoice({ user_id: 'd', channel_id: 'room', joined_at: 25 });
    expect(ids(store.voice.get('room'))).toEqual(['a', 'b', 'd', 'c']);
  });

  it('is what a real store uses', () => {
    expect(freshStore().voice).toBeInstanceOf(VoiceRooms);
  });
});
