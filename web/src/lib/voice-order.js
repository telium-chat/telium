/// Who is in a call, in the order they joined. The server lists a room in whatever order its query returns, which is
/// not the order the live join events arrive in, so a refetch (a reconnect, a reopened room) used to shuffle the tiles
/// under people mid-call. `joined_at` is on every state; the id breaks a tie so two clients agree.
const joinedAt = (v) => (typeof v?.joined_at === 'number' ? v.joined_at : Number.MAX_SAFE_INTEGER);

export function orderParticipants(list) {
  if (!Array.isArray(list)) return list;
  return list.sort((a, b) => (
    joinedAt(a) - joinedAt(b) || String(a?.user_id ?? '').localeCompare(String(b?.user_id ?? ''))
  ));
}

/// A `store.voice` that keeps each room in join order on every write, so no caller that sets a list has to remember to.
export class VoiceRooms extends Map {
  set(roomId, list) {
    return super.set(roomId, orderParticipants(list));
  }
}
