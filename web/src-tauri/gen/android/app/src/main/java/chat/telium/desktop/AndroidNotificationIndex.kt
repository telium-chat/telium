package chat.telium.desktop

import android.content.Context
import androidx.core.app.NotificationManagerCompat
import org.json.JSONObject

/// Which shown notifications belong to which conversation or channel, so reading that place --
/// here, or on another device (a `dismiss` inbox row) -- can take exactly those alerts down.
///
/// Notification tags are the account home's opaque bucket ids (or the inbox id for rows without
/// one), which this device cannot map back to a place, so the mapping is recorded as each alert is
/// posted. It holds only ids the device already decrypted, in app-private storage, per account
/// scope, and is bounded.
internal object AndroidNotificationIndex {
  private const val PREFS = "telium.notification.index"
  private const val MAX_TAGS_PER_PLACE = 32
  private const val MAX_PLACES = 256

  /// A stable key for where a descriptor points, or null for places that are never dismissed
  /// (account events, calls -- those expire on their own).
  fun placeOf(destination: JSONObject?): String? {
    destination ?: return null
    return placeFor(
      type = destination.optString("type"),
      conversationId = destination.optString("conversation_id"),
      guildOrigin = destination.optString("guild_origin"),
      guildId = destination.optString("guild_id"),
      channelId = destination.optString("channel_id"),
    )
  }

  /// A guild message and its channel share one place: reading the channel clears every mention in it.
  fun placeFor(
    type: String?,
    conversationId: String? = null,
    guildOrigin: String? = null,
    guildId: String? = null,
    channelId: String? = null,
  ): String? = when (type) {
    "conversation" -> conversationId
      ?.takeIf { it.isNotBlank() && it.length <= 1024 }
      ?.let { "conversation:$it" }
    "guild_message", "guild_channel" -> {
      if (guildOrigin.isNullOrBlank() || guildId.isNullOrBlank() || channelId.isNullOrBlank()) null
      else "channel:$guildOrigin:$guildId:$channelId".takeIf { it.length <= 2048 }
    }
    else -> null
  }

  private fun key(scopeId: String, place: String) = "$scopeId\u0000$place"

  @Synchronized
  fun remember(context: Context, scopeId: String, place: String, tag: String) {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val key = key(scopeId, place)
    val tags = (prefs.getStringSet(key, emptySet()) ?: emptySet()).toMutableSet()
    if (!tags.add(tag)) return
    while (tags.size > MAX_TAGS_PER_PLACE) tags.remove(tags.first())
    val editor = prefs.edit()
    if (prefs.all.size >= MAX_PLACES && !prefs.contains(key)) {
      // Oldest-first is not tracked; any place this old has long been read or swiped away.
      prefs.all.keys.firstOrNull()?.let(editor::remove)
    }
    editor.putStringSet(key, tags).apply()
  }

  /// Cancels every alert recorded for `place` and forgets them. Returns how many were cancelled.
  @Synchronized
  fun dismiss(context: Context, scopeId: String, place: String): Int {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val key = key(scopeId, place)
    val tags = prefs.getStringSet(key, emptySet()) ?: emptySet()
    if (tags.isEmpty()) return 0
    val manager = NotificationManagerCompat.from(context)
    for (tag in tags) manager.cancel(tag, 0)
    prefs.edit().remove(key).apply()
    return tags.size
  }

  @Synchronized
  fun clear(context: Context) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply()
  }
}
