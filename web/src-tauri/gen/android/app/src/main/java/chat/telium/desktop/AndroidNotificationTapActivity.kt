package chat.telium.desktop

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.core.app.NotificationManagerCompat
import org.json.JSONObject

/**
 * Tiny no-UI trampoline for native notification taps.
 *
 * The system PendingIntent does not need access to Telium's WebView. It stores
 * one validated account-bound destination, reopens the singleTask MainActivity,
 * and exits. MainActivity's existing resume event then lets the web client
 * consume it.
 */
class AndroidNotificationTapActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    AndroidNotificationTapStore.capture(
      this,
      intent.getStringExtra(AndroidNotificationTapStore.EXTRA_USER_ID),
      intent.getStringExtra(AndroidNotificationTapStore.EXTRA_DESTINATION),
      intent.getStringExtra(AndroidNotificationTapStore.EXTRA_ACTION),
    )
    intent.getStringExtra(AndroidNotificationTapStore.EXTRA_NOTIFICATION_TAG)
      ?.takeIf { it.isNotBlank() && it.length <= 1024 }
      ?.let { NotificationManagerCompat.from(this).cancel(it, 0) }
    startActivity(
      Intent(this, MainActivity::class.java).apply {
        addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      },
    )
    finish()
  }
}

internal object AndroidNotificationTapStore {
  const val EXTRA_USER_ID = "telium_notification_user_id"
  const val EXTRA_DESTINATION = "telium_notification_destination"
  const val EXTRA_ACTION = "telium_notification_action"
  const val EXTRA_NOTIFICATION_TAG = "telium_notification_tag"

  private const val PREFS = "telium_notification_tap_v1"
  private const val PENDING = "pending_destination"
  private const val MAX_DESTINATION_BYTES = 4096

  fun capture(context: Context, userId: String?, raw: String?, action: String? = null) {
    if (userId.isNullOrBlank() || userId.length > 1024) return
    if (raw.isNullOrBlank() || raw.toByteArray(Charsets.UTF_8).size > MAX_DESTINATION_BYTES) return
    val destination = try { JSONObject(raw) } catch (_: Exception) { return }
    if (!validDestination(destination)) return
    if (!AndroidNotificationDestination.isValidAction(action, destination.optString("type"))) return
    val pending = JSONObject()
      .put("user_id", userId)
      .put("destination", destination)
    if (!action.isNullOrBlank()) pending.put("action", action)
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .edit()
      .putString(PENDING, pending.toString())
      .apply()
  }

  fun take(context: Context): JSONObject? {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val raw = prefs.getString(PENDING, null) ?: return null
    // Consume exactly once. If the destination somehow became malformed, it is
    // still safer to drop it than to keep retrying an attacker-controlled blob.
    prefs.edit().remove(PENDING).apply()
    val value = try { JSONObject(raw) } catch (_: Exception) { return null }
    val userId = value.optString("user_id")
    val destination = value.optJSONObject("destination")
    if (userId.isBlank() || userId.length > 1024 || destination == null) return null
    val action = value.optString("action").takeIf { it.isNotBlank() }
    return value.takeIf {
      validDestination(destination)
        && AndroidNotificationDestination.isValidAction(action, destination.optString("type"))
    }
  }

  fun clear(context: Context) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .edit()
      .remove(PENDING)
      .apply()
  }

  /// Each destination shape is checked exactly, and an unknown `type` is
  /// refused rather than allowed through on the strength of whichever fields it
  /// happens to carry. The rule itself lives in `AndroidNotificationDestination`
  /// because the tap trampoline is no longer the only native caller that needs
  /// it, and two copies of a validation rule are two rules the moment one of
  /// them is edited.
  ///
  /// It still has to agree field for field with `validDestination` in
  /// web/src/lib/android-notification-navigation.js: a destination this
  /// trampoline stores but the web client will not route is a tap that opens
  /// Telium to nowhere and never says why.
  ///
  /// A conversation destination carries no message id because there is none to
  /// carry -- the account home queued that wake knowing only that a frame
  /// arrived -- so the conversation alone is the whole route.
  private fun validDestination(value: JSONObject): Boolean {
    return AndroidNotificationDestination.isValid(
      type = value.optString("type"),
      guildOrigin = value.optString("guild_origin"),
      guildId = value.optString("guild_id"),
      channelId = value.optString("channel_id"),
      messageId = value.optString("message_id"),
      conversationId = value.optString("conversation_id"),
    )
  }
}
