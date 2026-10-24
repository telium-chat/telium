package chat.telium.desktop

import android.app.Activity
import android.content.Context
import android.util.Log
import org.json.JSONObject
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.UnifiedPush
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import java.util.concurrent.Executors

/**
 * Provider-neutral Android wake transport.
 *
 * UnifiedPush chooses either an external distributor or the embedded FCM
 * fallback. The homeserver still speaks ordinary Web Push/VAPID and receives
 * only the resulting endpoint plus its Web Push public material. A provider
 * wake contains no Telium content; it only asks the native encrypted inbox to
 * drain.
 */
internal object AndroidNotificationPush {
  private const val TAG = "TeliumNotificationPush"
  private const val PREFS_NAME = "telium_native_push_v1"
  private const val CONNECT_TIMEOUT_MS = 10_000
  private const val READ_TIMEOUT_MS = 10_000

  data class Status(
    val configured: Boolean,
    val distributorReady: Boolean,
    val endpointRegistered: Boolean,
    val wakeVerified: Boolean,
    val wakeReceivedAt: Long,
  )

  private val executor = Executors.newSingleThreadExecutor()

  fun enable(
    activity: Activity,
    scope: AndroidNotificationStore.Scope,
    vapidPublicKey: String,
    callback: (Boolean, String?) -> Unit,
  ) {
    val vapid = vapidPublicKey.trim()
    if (vapid.length != 87 || !vapid.all { it.isLetterOrDigit() || it == '-' || it == '_' }) {
      callback(false, "Homeserver returned an invalid VAPID public key.")
      return
    }

    prefs(activity).edit()
      .putString(vapidKey(scope.id), vapid)
      .putBoolean(endpointKey(scope.id), false)
      .apply()

    try {
      UnifiedPush.tryUseCurrentOrDefaultDistributor(activity) { success ->
        if (!success) {
          callback(false, "No Android push distributor was selected.")
          return@tryUseCurrentOrDefaultDistributor
        }
        try {
          register(activity.applicationContext, scope, vapid)
          callback(true, null)
        } catch (error: Exception) {
          callback(false, error.message ?: "Android push registration failed.")
        }
      }
    } catch (error: Exception) {
      callback(false, error.message ?: "Android push setup failed.")
    }
  }

  /** Re-register on every app resume, as UnifiedPush recommends. */
  fun refresh(activity: Activity) {
    val registration = AndroidNotificationStore.activeRegistration(activity) ?: return
    val scope = registration.scope
    val vapid = prefs(activity).getString(vapidKey(scope.id), null) ?: return

    try {
      if (UnifiedPush.getAckDistributor(activity) != null) {
        register(activity.applicationContext, scope, vapid)
      } else {
        // The previous distributor may have been removed. Only do this for an
        // already-configured Telium device; a user who never enabled native
        // background delivery must never get a surprise picker at startup.
        UnifiedPush.tryUseCurrentOrDefaultDistributor(activity) { success ->
          if (success) {
            try {
              register(activity.applicationContext, scope, vapid)
            } catch (error: Exception) {
              Log.w(TAG, "Could not refresh push registration", error)
            }
          }
        }
      }
    } catch (error: Exception) {
      Log.w(TAG, "Could not refresh UnifiedPush distributor", error)
    }
  }

  fun status(context: Context, scope: AndroidNotificationStore.Scope): Status {
    val prefs = prefs(context)
    val endpointRegistered = prefs.getBoolean(endpointKey(scope.id), false)
    val endpointRegisteredAt = prefs.getLong(endpointRegisteredAtKey(scope.id), 0L)
    val wakeReceivedAt = prefs.getLong(wakeReceivedAtKey(scope.id), 0L)
    return Status(
      configured = prefs.contains(vapidKey(scope.id)),
      distributorReady = try {
        UnifiedPush.getAckDistributor(context) != null
      } catch (_: Exception) {
        false
      },
      endpointRegistered = endpointRegistered,
      wakeVerified = endpointRegistered
        && endpointRegisteredAt > 0L
        && wakeReceivedAt >= endpointRegisteredAt,
      wakeReceivedAt = wakeReceivedAt,
    )
  }

  fun clear(context: Context, scope: AndroidNotificationStore.Scope) {
    try {
      UnifiedPush.unregister(context, scope.id)
    } catch (_: Exception) {
      // Secret destruction/sign-out must not depend on a distributor still
      // being installed or reachable.
    }
    prefs(context).edit()
      .remove(vapidKey(scope.id))
      .remove(endpointKey(scope.id))
      .remove(endpointRegisteredAtKey(scope.id))
      .remove(wakeReceivedAtKey(scope.id))
      .apply()
  }

  internal fun onNewEndpoint(context: Context, endpoint: PushEndpoint, instance: String) {
    val registration = AndroidNotificationStore.activeRegistration(context) ?: return
    if (registration.scope.id != instance) return
    prefs(context).edit()
      .putBoolean(endpointKey(instance), false)
      .remove(endpointRegisteredAtKey(instance))
      .apply()
    executor.execute {
      val ok = try {
        uploadEndpoint(registration, endpoint)
        true
      } catch (error: Exception) {
        Log.w(TAG, "Could not upload native push endpoint", error)
        false
      }
      val edit = prefs(context).edit().putBoolean(endpointKey(instance), ok)
      if (ok) {
        edit.putLong(endpointRegisteredAtKey(instance), System.currentTimeMillis())
      } else {
        edit.remove(endpointRegisteredAtKey(instance))
      }
      edit.apply()
    }
  }

  internal fun onMessage(context: Context, message: PushMessage, instance: String) {
    val registration = AndroidNotificationStore.activeRegistration(context) ?: return
    if (registration.scope.id != instance) return

    val body = try {
      JSONObject(String(message.content, StandardCharsets.UTF_8))
    } catch (_: Exception) {
      return
    }
    // Distributor data is never the notification itself. Even an unexpected
    // or malicious local distributor can at most cause a harmless authenticated
    // inbox poll; it cannot fabricate title/body/navigation content.
    if (body.optString("type") == "wake") {
      // Setup verification reads this timestamp through the narrow WebView
      // bridge. It proves the provider round trip reached the same native
      // PushService real notifications use; merely uploading an endpoint is
      // not enough to call killed-app wake ready.
      prefs(context).edit()
        .putLong(wakeReceivedAtKey(instance), System.currentTimeMillis())
        .apply()
      // Queue a durable recovery edge before starting the low-latency in-process
      // drain. If Android kills this PushService process, WorkManager still
      // retries once connectivity is available.
      AndroidNotificationInbox.scheduleRecovery(context)
      AndroidNotificationInbox.drain(context)
    }
  }

  internal fun onRegistrationFailed(
    context: Context,
    reason: FailedReason,
    instance: String,
  ) {
    prefs(context).edit()
      .putBoolean(endpointKey(instance), false)
      .remove(endpointRegisteredAtKey(instance))
      .apply()
    Log.w(TAG, "UnifiedPush registration failed for $instance: $reason")
  }

  internal fun onUnregistered(context: Context, instance: String) {
    prefs(context).edit()
      .putBoolean(endpointKey(instance), false)
      .remove(endpointRegisteredAtKey(instance))
      .apply()
  }

  private fun register(
    context: Context,
    scope: AndroidNotificationStore.Scope,
    vapid: String,
  ) {
    UnifiedPush.register(
      context = context,
      instance = scope.id,
      messageForDistributor = "Telium messages",
      vapid = vapid,
    )
  }

  private fun uploadEndpoint(
    registration: AndroidNotificationStore.Registration,
    endpoint: PushEndpoint,
  ) {
    val keys = endpoint.pubKeySet
    val body = JSONObject()
      .put("kind", if (keys == null) "relay" else "native-webpush")
      .put("endpoint", endpoint.url)
    if (keys != null) {
      body.put("p256dh", keys.pubKey)
      body.put("auth", keys.auth)
    }

    val connection = (URL(registration.scope.homeBase + "/_telium/v1/push")
      .openConnection() as HttpURLConnection).apply {
      requestMethod = "POST"
      connectTimeout = CONNECT_TIMEOUT_MS
      readTimeout = READ_TIMEOUT_MS
      instanceFollowRedirects = false
      doOutput = true
      setRequestProperty(
        "Authorization",
        "Telium-Notification ${registration.backgroundToken}",
      )
      setRequestProperty("Accept", "application/json")
      setRequestProperty("Content-Type", "application/json")
    }

    try {
      connection.outputStream.use { stream ->
        stream.write(body.toString().toByteArray(StandardCharsets.UTF_8))
      }
      val status = connection.responseCode
      if (status !in 200..299) {
        val error = connection.errorStream
          ?.bufferedReader(StandardCharsets.UTF_8)
          ?.use { it.readText() }
          .orEmpty()
        throw IOException("Push endpoint registration returned HTTP $status${if (error.isBlank()) "" else ": $error"}")
      }
    } finally {
      connection.disconnect()
    }
  }

  private fun prefs(context: Context) =
    context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

  private fun vapidKey(scopeId: String) = "$scopeId.vapid"
  private fun endpointKey(scopeId: String) = "$scopeId.endpoint_registered"
  private fun endpointRegisteredAtKey(scopeId: String) = "$scopeId.endpoint_registered_at"
  private fun wakeReceivedAtKey(scopeId: String) = "$scopeId.wake_received_at"
}

/** Entry point invoked by any UnifiedPush distributor, including embedded FCM. */
class AndroidNotificationPushService : PushService() {
  override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) {
    AndroidNotificationPush.onNewEndpoint(this, endpoint, instance)
  }

  override fun onMessage(message: PushMessage, instance: String) {
    AndroidNotificationPush.onMessage(this, message, instance)
  }

  override fun onRegistrationFailed(reason: FailedReason, instance: String) {
    AndroidNotificationPush.onRegistrationFailed(this, reason, instance)
  }

  override fun onUnregistered(instance: String) {
    AndroidNotificationPush.onUnregistered(this, instance)
  }

  override fun onTempUnavailable(instance: String) {
    Log.w("TeliumNotificationPush", "UnifiedPush temporarily unavailable for $instance")
  }
}
