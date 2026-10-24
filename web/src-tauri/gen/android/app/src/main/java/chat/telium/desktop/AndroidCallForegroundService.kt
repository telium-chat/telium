package chat.telium.desktop

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * Android lifecycle anchor for an already-authenticated WebRTC call.
 *
 * The service deliberately receives no Telium session, channel ID, participant
 * list, or media key. MainActivity only tells it whether Chromium currently has
 * an active call. Its notification can return the user to that Activity; all
 * call control remains in the authenticated client.
 */
class AndroidCallForegroundService : Service() {
  override fun onCreate() {
    super.onCreate()
    ensureChannel()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_HANG_UP,
      ACTION_TOGGLE_MUTE,
      ACTION_TOGGLE_DEAFEN -> {
        sendBroadcast(Intent(intent.action).setPackage(packageName))
        return START_NOT_STICKY
      }
    }

    val muted = intent?.getBooleanExtra(EXTRA_MUTED, false) ?: false
    val deafened = intent?.getBooleanExtra(EXTRA_DEAFENED, false) ?: false
    val returnIntent = Intent(this, MainActivity::class.java).apply {
      this.flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
    }
    val returnPending = PendingIntent.getActivity(
      this,
      REQUEST_RETURN,
      returnIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val hangUpPending = PendingIntent.getService(
      this,
      REQUEST_HANG_UP,
      Intent(this, AndroidCallForegroundService::class.java).setAction(ACTION_HANG_UP),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val mutePending = PendingIntent.getService(
      this,
      REQUEST_MUTE,
      Intent(this, AndroidCallForegroundService::class.java).setAction(ACTION_TOGGLE_MUTE),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val deafenPending = PendingIntent.getService(
      this,
      REQUEST_DEAFEN,
      Intent(this, AndroidCallForegroundService::class.java).setAction(ACTION_TOGGLE_DEAFEN),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val caller = Person.Builder()
      .setName("Telium")
      .setImportant(true)
      .build()
    val notification = NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_launcher_monochrome)
      .setContentTitle("Telium call")
      .setContentText("Call in progress")
      .setContentIntent(returnPending)
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setStyle(NotificationCompat.CallStyle.forOngoingCall(caller, hangUpPending))
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setSilent(true)
      .addAction(R.drawable.ic_launcher_monochrome, "Return", returnPending)
      .apply {
        if (!deafened) {
          addAction(
            R.drawable.ic_launcher_monochrome,
            if (muted) "Unmute" else "Mute",
            mutePending,
          )
        }
        addAction(
          R.drawable.ic_launcher_monochrome,
          if (deafened) "Undeafen" else "Deafen",
          deafenPending,
        )
      }
      .build()

    val foregroundType = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
    } else {
      0
    }
    ServiceCompat.startForeground(
      this,
      NOTIFICATION_ID,
      notification,
      foregroundType,
    )
    return START_NOT_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onDestroy() {
    ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    super.onDestroy()
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(
      NotificationChannel(
        CHANNEL_ID,
        "Active calls",
        NotificationManager.IMPORTANCE_LOW,
      ).apply {
        description = "Shows while a Telium call is active"
        setSound(null, null)
        enableVibration(false)
      },
    )
  }

  companion object {
    const val ACTION_HANG_UP = "chat.telium.desktop.action.HANG_UP_CALL"
    const val ACTION_TOGGLE_MUTE = "chat.telium.desktop.action.TOGGLE_MUTE_CALL"
    const val ACTION_TOGGLE_DEAFEN = "chat.telium.desktop.action.TOGGLE_DEAFEN_CALL"
    private const val EXTRA_MUTED = "muted"
    private const val EXTRA_DEAFENED = "deafened"
    private const val CHANNEL_ID = "telium_active_call"
    private const val NOTIFICATION_ID = 0x54434c
    private const val REQUEST_RETURN = 0x54434d
    private const val REQUEST_HANG_UP = 0x54434e
    private const val REQUEST_MUTE = 0x54434f
    private const val REQUEST_DEAFEN = 0x544350

    fun start(context: Context, muted: Boolean = false, deafened: Boolean = false) {
      try {
        ContextCompat.startForegroundService(
          context,
          Intent(context, AndroidCallForegroundService::class.java)
            .putExtra(EXTRA_MUTED, muted)
            .putExtra(EXTRA_DEAFENED, deafened),
        )
      } catch (_: Exception) {
        // The WebRTC call remains usable in the foreground if Android rejects
        // service startup (for example because microphone permission changed).
      }
    }

    fun stop(context: Context) {
      try {
        context.stopService(Intent(context, AndroidCallForegroundService::class.java))
      } catch (_: Exception) {
        // Service teardown must not block restoring the Activity audio state.
      }
    }
  }
}
