package chat.telium.desktop

import android.app.Activity
import android.webkit.WebView
import androidx.core.app.NotificationManagerCompat
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject

/**
 * Narrow WebView boundary for Android-owned notification secrets.
 *
 * JavaScript may obtain the public notification key and hand a freshly-issued
 * scoped background credential into Android. It can never read the private key
 * or retrieve that credential after storage. The same origin-scoped bridge
 * also hands one already-decrypted notification destination to the signed-in
 * client after the user taps the system notification.
 */
object AndroidNotificationBridge {
  const val ALGORITHM = AndroidNotificationStore.ALGORITHM

  private const val BRIDGE_NAME = "teliumAndroidNotificationBridge"
  private val allowedOrigins = setOf("http://tauri.localhost", "https://tauri.localhost")

  fun install(activity: Activity, webView: WebView) {
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return

    WebViewCompat.addWebMessageListener(
      webView,
      BRIDGE_NAME,
      allowedOrigins,
      WebViewCompat.WebMessageListener { _, message, _, isMainFrame, replyProxy ->
        if (!isMainFrame || message.type != WebMessageCompat.TYPE_STRING) {
          return@WebMessageListener
        }

        val payload = try {
          JSONObject(message.data ?: "")
        } catch (_: Exception) {
          reply(replyProxy, null, "error", ok = false, message = "Invalid notification request.")
          return@WebMessageListener
        }
        val requestId = payload.optString("request_id").takeIf { it.isNotBlank() }

        try {
          when (payload.optString("op")) {
            "prepare" -> prepare(activity, payload, replyProxy, requestId)
            "store_registration" -> storeRegistration(activity, payload, replyProxy, requestId)
            "enable_wake" -> enableWake(activity, payload, replyProxy, requestId)
            "set_preview" -> setPreview(activity, payload, replyProxy, requestId)
            "set_dm_notifications" -> setDmNotifications(activity, payload, replyProxy, requestId)
            "status" -> status(activity, payload, replyProxy, requestId)
            "clear" -> clear(activity, payload, replyProxy, requestId)
            "take_destination" -> takeDestination(activity, replyProxy, requestId)
            else -> reply(
              replyProxy,
              requestId,
              "error",
              ok = false,
              message = "Unknown notification operation.",
            )
          }
        } catch (error: Exception) {
          reply(
            replyProxy,
            requestId,
            "error",
            ok = false,
            message = error.message ?: "Android notification storage failed.",
          )
        }
      },
    )

    // UnifiedPush explicitly recommends regular re-registration. Do it whenever
    // the Android shell starts, but only if this installation already has a
    // configured Telium notification identity; refresh() is otherwise a no-op.
    AndroidNotificationPush.refresh(activity)
  }

  private fun prepare(
    activity: Activity,
    payload: JSONObject,
    replyProxy: JavaScriptReplyProxy,
    requestId: String?,
  ) {
    val prepared = AndroidNotificationStore.prepare(activity, scope(payload))
    reply(
      replyProxy,
      requestId,
      "prepared",
      ok = true,
      extra = mapOf(
        "algorithm" to prepared.algorithm,
        "public_key" to prepared.publicKey,
        "registered" to prepared.registered,
      ),
    )
  }

  private fun storeRegistration(
    activity: Activity,
    payload: JSONObject,
    replyProxy: JavaScriptReplyProxy,
    requestId: String?,
  ) {
    AndroidNotificationStore.storeRegistration(
      activity,
      scope(payload),
      payload.optString("background_token"),
    )
    reply(replyProxy, requestId, "stored", ok = true)
  }

  private fun enableWake(
    activity: Activity,
    payload: JSONObject,
    replyProxy: JavaScriptReplyProxy,
    requestId: String?,
  ) {
    val scope = scope(payload)
    val vapid = payload.optString("vapid_public_key")
    AndroidNotificationPush.enable(activity, scope, vapid) { ok, error ->
      activity.runOnUiThread {
        if (ok) {
          reply(
            replyProxy,
            requestId,
            "wake_enabled",
            ok = true,
            extra = mapOf("wake_configured" to true),
          )
        } else {
          reply(
            replyProxy,
            requestId,
            "error",
            ok = false,
            message = error ?: "Android push setup failed.",
          )
        }
      }
    }
  }

  private fun setPreview(
    activity: Activity,
    payload: JSONObject,
    replyProxy: JavaScriptReplyProxy,
    requestId: String?,
  ) {
    val scope = scope(payload)
    AndroidNotificationStore.setPreviewMode(
      activity,
      scope,
      payload.optString("mode"),
    )
    reply(
      replyProxy,
      requestId,
      "preview_set",
      ok = true,
      extra = mapOf("preview_mode" to AndroidNotificationStore.previewMode(activity, scope)),
    )
  }

  private fun setDmNotifications(
    activity: Activity,
    payload: JSONObject,
    replyProxy: JavaScriptReplyProxy,
    requestId: String?,
  ) {
    val scope = scope(payload)
    AndroidNotificationStore.setDmNotifications(
      activity,
      scope,
      payload.optBoolean("enabled", true),
    )
    reply(
      replyProxy,
      requestId,
      "dm_notifications_set",
      ok = true,
      extra = mapOf(
        "dm_notifications" to AndroidNotificationStore.dmNotifications(activity, scope),
      ),
    )
  }

  private fun status(
    activity: Activity,
    payload: JSONObject,
    replyProxy: JavaScriptReplyProxy,
    requestId: String?,
  ) {
    val scope = scope(payload)
    val status = AndroidNotificationStore.status(activity, scope)
    val push = AndroidNotificationPush.status(activity, scope)
    reply(
      replyProxy,
      requestId,
      "status",
      ok = true,
      extra = mapOf(
        "prepared" to status.prepared,
        "registered" to status.registered,
        "preview_mode" to status.previewMode,
        "dm_notifications" to status.dmNotifications,
        "wake_configured" to push.configured,
        "wake_distributor_ready" to push.distributorReady,
        "wake_endpoint_registered" to push.endpointRegistered,
        "wake_verified" to push.wakeVerified,
        "wake_received_at" to push.wakeReceivedAt,
      ),
    )
  }

  private fun clear(
    activity: Activity,
    payload: JSONObject,
    replyProxy: JavaScriptReplyProxy,
    requestId: String?,
  ) {
    val scope = scope(payload)
    AndroidNotificationPush.clear(activity, scope)
    AndroidNotificationStore.clear(activity, scope)
    AndroidNotificationTapStore.clear(activity)
    NotificationManagerCompat.from(activity).cancelAll()
    reply(replyProxy, requestId, "cleared", ok = true)
  }

  private fun takeDestination(
    activity: Activity,
    replyProxy: JavaScriptReplyProxy,
    requestId: String?,
  ) {
    val tap = AndroidNotificationTapStore.take(activity)
    reply(
      replyProxy,
      requestId,
      "destination",
      ok = true,
      extra = if (tap == null) {
        mapOf("has_destination" to false)
      } else {
        mapOf(
          "has_destination" to true,
          "tap" to tap,
        )
      },
    )
  }

  private fun scope(payload: JSONObject) = AndroidNotificationStore.scope(
    payload.optString("home_base"),
    payload.optString("user_id"),
    payload.optString("device_id"),
  )

  private fun reply(
    proxy: JavaScriptReplyProxy,
    requestId: String?,
    op: String,
    ok: Boolean,
    message: String? = null,
    extra: Map<String, Any> = emptyMap(),
  ) {
    val json = JSONObject()
      .put("op", op)
      .put("ok", ok)
    if (requestId != null) json.put("request_id", requestId)
    if (message != null) json.put("message", message)
    for ((key, value) in extra) json.put(key, value)
    proxy.postMessage(json.toString())
  }
}
