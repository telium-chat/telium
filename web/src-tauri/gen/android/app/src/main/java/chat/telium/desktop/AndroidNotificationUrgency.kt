package chat.telium.desktop

/** Time-sensitive notification policy kept free of Android framework APIs. */
internal object AndroidNotificationUrgency {
  // A provider wake may be delayed by Doze or network loss. Calls are useful
  // only while they are actually ringing, so an old inbox row must never turn
  // into a fresh alert when connectivity returns much later.
  const val CALL_TTL_MS = 60_000L

  fun isIncomingCall(kind: String): Boolean = kind == "call" || kind == "incoming_call"

  fun shouldDisplay(kind: String, createdAtMs: Long, nowMs: Long): Boolean {
    if (!isIncomingCall(kind)) return true
    if (createdAtMs <= 0L) return false
    return createdAtMs >= nowMs - CALL_TTL_MS
  }

  fun timeoutAfterMs(kind: String, createdAtMs: Long, nowMs: Long): Long? {
    if (!isIncomingCall(kind) || !shouldDisplay(kind, createdAtMs, nowMs)) return null
    val age = (nowMs - createdAtMs).coerceAtLeast(0L)
    return (CALL_TTL_MS - age).coerceAtLeast(1L)
  }
}
