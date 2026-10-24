package chat.telium.desktop

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationManagerCompat

/** Handles actions that do not need a Telium WebView or session. */
class AndroidNotificationActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != ACTION_DECLINE_CALL) return
    val tag = intent.getStringExtra(EXTRA_NOTIFICATION_TAG) ?: return
    if (tag.isBlank() || tag.length > 1024) return
    NotificationManagerCompat.from(context).cancel(tag, 0)
  }

  companion object {
    const val ACTION_DECLINE_CALL = "chat.telium.desktop.notification.DECLINE_CALL"
    const val EXTRA_NOTIFICATION_TAG = "telium_notification_tag"
  }
}
