package chat.telium.desktop

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Base64
import android.webkit.CookieManager
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.io.OutputStream
import java.util.Locale
import java.util.concurrent.Executors

class MainActivity : TauriActivity() {
  private data class PendingSave(
    val name: String,
    val mime: String,
    val size: Long,
    val reply: JavaScriptReplyProxy,
    var uri: Uri? = null,
    var stream: OutputStream? = null,
    var written: Long = 0,
  )

  private var teliumWebView: WebView? = null
  private var pendingSave: PendingSave? = null
  private var pendingSharedText: String? = null
  private var callActive = false
  private var callMuted = false
  private var callDeafened = false
  private var savedAudioMode: Int? = null
  private var requestedCommunicationDeviceId: Int? = null
  private var audioFocusRequest: AudioFocusRequest? = null
  private var legacyAudioFocusHeld = false
  private lateinit var telecomCallManager: AndroidTelecomCallManager
  private var callActionReceiverRegistered = false
  private val saveExecutor = Executors.newSingleThreadExecutor()
  private val callActionReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      when (intent?.action) {
        AndroidCallForegroundService.ACTION_HANG_UP ->
          publishAndroidCallControl(AndroidTelecomCallManager.CONTROL_DISCONNECT)
        AndroidCallForegroundService.ACTION_TOGGLE_MUTE ->
          publishAndroidCallControl("toggle_mute")
        AndroidCallForegroundService.ACTION_TOGGLE_DEAFEN ->
          publishAndroidCallControl("toggle_deafen")
      }
    }
  }

  private val saveDocument = registerForActivityResult(
    ActivityResultContracts.StartActivityForResult()
  ) { result ->
    val pending = pendingSave ?: return@registerForActivityResult
    val uri = result.data?.data
    if (result.resultCode != Activity.RESULT_OK || uri == null) {
      pendingSave = null
      reply(pending.reply, "cancelled", ok = false)
      return@registerForActivityResult
    }

    try {
      val stream = contentResolver.openOutputStream(uri, "w")
        ?: throw IllegalStateException("Android could not open the selected file.")
      pending.uri = uri
      pending.stream = stream
      reply(
        pending.reply,
        "ready",
        ok = true,
        extra = mapOf(
          "binary" to WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER)
        ),
      )
    } catch (error: Exception) {
      pendingSave = null
      reply(pending.reply, "error", ok = false, message = error.message ?: "Could not open the selected file.")
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    telecomCallManager = AndroidTelecomCallManager(applicationContext) { action ->
      publishAndroidCallControl(action)
    }
    ContextCompat.registerReceiver(
      this,
      callActionReceiver,
      IntentFilter().apply {
        addAction(AndroidCallForegroundService.ACTION_HANG_UP)
        addAction(AndroidCallForegroundService.ACTION_TOGGLE_MUTE)
        addAction(AndroidCallForegroundService.ACTION_TOGGLE_DEAFEN)
      },
      ContextCompat.RECEIVER_NOT_EXPORTED,
    )
    callActionReceiverRegistered = true
    captureShareIntent(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    captureShareIntent(intent)
    teliumWebView?.let { view ->
      view.post {
        view.evaluateJavascript(
          "window.dispatchEvent(new Event('telium:share-intent'));",
          null
        )
      }
    }
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    teliumWebView = webView

    // Tauri/Wry already owns the WebChromeClient, including Android runtime
    // permission requests for getUserMedia. Keep that intact and only bridge
    // system-bar/cutout/IME insets into CSS. Some Android System WebView releases
    // report env(safe-area-inset-*) as zero under edge-to-edge.
    ViewCompat.setOnApplyWindowInsetsListener(webView) { _, insets ->
      publishSafeArea(webView, insets)
      insets
    }
    webView.post { ViewCompat.requestApplyInsets(webView) }

    installFileSaveBridge(webView)
    installCallBridge(webView)
    installShareBridge(webView)
    installGofileBridge(webView)
    AndroidNotificationBridge.install(this, webView)
  }

  override fun onResume() {
    super.onResume()
    AndroidNotificationInbox.drain(this)
    teliumWebView?.let { view ->
      view.post {
        ViewCompat.requestApplyInsets(view)
        // Android can resume a WebView without producing the same visibility
        // transition every browser tab does. Give the client an explicit wake
        // edge so it can probe/reconnect gateway sockets immediately.
        view.evaluateJavascript(
          "window.dispatchEvent(new Event('telium:resume'));",
          null
        )
        if (callActive) applyCallMode(true, view)
      }
    }
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    if (hasFocus) {
      teliumWebView?.let { view ->
        view.post { ViewCompat.requestApplyInsets(view) }
      }
    }
  }

  override fun onDestroy() {
    teliumWebView?.let { view -> applyCallMode(false, view) }
    if (callActionReceiverRegistered) {
      try { unregisterReceiver(callActionReceiver) } catch (_: Exception) {}
      callActionReceiverRegistered = false
    }
    if (::telecomCallManager.isInitialized) telecomCallManager.close()
    pendingSave?.stream?.let { stream ->
      try { stream.close() } catch (_: Exception) {}
    }
    pendingSave = null
    saveExecutor.shutdownNow()
    teliumWebView = null
    super.onDestroy()
  }

  private fun captureShareIntent(source: Intent?) {
    if (source?.action != Intent.ACTION_SEND) return
    if (source.type?.startsWith("text/") != true) return

    val text = source.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()
    val subject = source.getCharSequenceExtra(Intent.EXTRA_SUBJECT)?.toString()
    pendingSharedText = when {
      !text.isNullOrBlank() -> text
      !subject.isNullOrBlank() -> subject
      else -> null
    }
  }

  /// Android's share sheet can start Telium before its WebView is ready, or
  /// deliver a second ACTION_SEND into this singleTask activity while a session
  /// is already open. Hold one pending text payload natively and let the signed-
  /// in shell consume it exactly once.
  private fun installShareBridge(webView: WebView) {
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return

    WebViewCompat.addWebMessageListener(
      webView,
      "teliumAndroidShareBridge",
      setOf("http://tauri.localhost", "https://tauri.localhost"),
      WebViewCompat.WebMessageListener { _, message, _, isMainFrame, replyProxy ->
        if (!isMainFrame || message.type != WebMessageCompat.TYPE_STRING) {
          return@WebMessageListener
        }

        val payload = try { JSONObject(message.data ?: "") } catch (_: Exception) {
          reply(replyProxy, "share", ok = false, message = "Invalid share request.")
          return@WebMessageListener
        }
        val requestId = payload.optString("request_id").takeIf { it.isNotBlank() }
        if (payload.optString("op") != "take") {
          reply(
            replyProxy,
            "share",
            ok = false,
            message = "Unknown share operation.",
            extra = responseExtra(requestId),
          )
          return@WebMessageListener
        }

        val shared = pendingSharedText
        pendingSharedText = null
        reply(
          replyProxy,
          "share",
          ok = true,
          extra = responseExtra(
            requestId,
            if (shared == null) {
              mapOf("has_share" to false)
            } else {
              mapOf("has_share" to true, "text" to shared)
            },
          ),
        )
      },
    )
  }

  /// Gofile's free web-download URLs require an accountToken cookie. This is a
  /// viewer-only disposable guest token obtained through Telium's authenticated
  /// control plane; it is never the uploader's token. Once installed, Chromium's own media
  /// stack requests the original Gofile URL directly, including byte ranges.
  private fun installGofileBridge(webView: WebView) {
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return

    val cookies = CookieManager.getInstance()
    cookies.setAcceptCookie(true)

    WebViewCompat.addWebMessageListener(
      webView,
      "teliumAndroidGofileBridge",
      setOf("http://tauri.localhost", "https://tauri.localhost"),
      WebViewCompat.WebMessageListener { view, message, _, isMainFrame, replyProxy ->
        if (!isMainFrame || message.type != WebMessageCompat.TYPE_STRING) {
          return@WebMessageListener
        }

        val payload = try { JSONObject(message.data ?: "") } catch (_: Exception) {
          reply(replyProxy, "gofile", ok = false, message = "Invalid Gofile playback request.")
          return@WebMessageListener
        }
        val requestId = payload.optString("request_id").takeIf { it.isNotBlank() }
        if (payload.optString("op") != "session") {
          reply(
            replyProxy,
            "gofile",
            ok = false,
            message = "Unknown Gofile playback operation.",
            extra = responseExtra(requestId),
          )
          return@WebMessageListener
        }

        val source = payload.optString("source")
        val token = payload.optString("token")
        val sourceUri = try { Uri.parse(source) } catch (_: Exception) { null }
        val host = sourceUri?.host?.lowercase(Locale.US)
        val validHost = host == "gofile.io" || host?.endsWith(".gofile.io") == true
        val validToken = token.length in 16..2048
          && token.all {
            (it in 'a'..'z') || (it in 'A'..'Z') || (it in '0'..'9')
              || it == '-' || it == '_' || it == '.'
          }
        if (sourceUri?.scheme != "https"
          || !validHost
          || sourceUri.path?.startsWith("/download/") != true
          || !validToken
        ) {
          reply(
            replyProxy,
            "gofile",
            ok = false,
            message = "Gofile playback request was rejected.",
            extra = responseExtra(requestId),
          )
          return@WebMessageListener
        }

        // Tauri's app origin and gofile.io are different sites. Android WebView
        // blocks third-party cookies by default, so opt this WebView in only
        // after the user actually encounters a Gofile attachment. This is
        // broader than one domain at the WebView API level; the credential we
        // install remains scoped exclusively to gofile.io.
        cookies.setAcceptThirdPartyCookies(webView, true)
        val cookie = "accountToken=$token; Domain=gofile.io; Path=/; Secure; HttpOnly; SameSite=None"
        cookies.setCookie("https://gofile.io/", cookie) { accepted ->
          view.post {
            if (accepted) {
              cookies.flush()
              reply(
                replyProxy,
                "gofile",
                ok = true,
                extra = responseExtra(requestId),
              )
            } else {
              reply(
                replyProxy,
                "gofile",
                ok = false,
                message = "Android WebView rejected the Gofile viewer cookie.",
                extra = responseExtra(requestId),
              )
            }
          }
        }
      },
    )
  }

  /// WebRTC runs inside Chromium, but Android still needs to know that the
  /// process is in a communications session. That changes route/volume policy
  /// (Bluetooth/headsets/speaker) and is the prerequisite for the modern
  /// communication-device APIs. The same state keeps the visible call screen
  /// awake without relying on the Screen Wake Lock web API, which Android
  /// WebView does not consistently expose.
  private fun installCallBridge(webView: WebView) {
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return

    WebViewCompat.addWebMessageListener(
      webView,
      "teliumAndroidCallBridge",
      setOf("http://tauri.localhost", "https://tauri.localhost"),
      WebViewCompat.WebMessageListener { view, message, _, isMainFrame, replyProxy ->
        if (!isMainFrame || message.type != WebMessageCompat.TYPE_STRING) {
          return@WebMessageListener
        }
        val payload = try { JSONObject(message.data ?: "") } catch (_: Exception) {
          reply(replyProxy, "call", ok = false, message = "Invalid call-state request.")
          return@WebMessageListener
        }
        val requestId = payload.optString("request_id").takeIf { it.isNotBlank() }
        when (payload.optString("op", if (payload.has("active")) "state" else "")) {
          "state" -> {
            callMuted = payload.optBoolean("muted", callMuted)
            callDeafened = payload.optBoolean("deafened", callDeafened)
            applyCallMode(payload.optBoolean("active"), view)
            reply(
              replyProxy,
              "call",
              ok = true,
              extra = responseExtra(requestId, mapOf("active" to callActive)),
            )
          }
          "routes" -> replyAudioRoutes(replyProxy, requestId)
          "select_route" -> selectAudioRoute(
            replyProxy,
            requestId,
            payload.optString("route_id"),
          )
          else -> reply(
            replyProxy,
            "call",
            ok = false,
            message = "Unknown call operation.",
            extra = responseExtra(requestId),
          )
        }
      },
    )
  }

  private fun applyCallMode(active: Boolean, webView: WebView) {
    val audio = getSystemService(AudioManager::class.java)
    if (active) {
      if (!callActive) {
        savedAudioMode = audio.mode
        callActive = true
        telecomCallManager.startCall()
      }
      AndroidCallForegroundService.start(this, callMuted, callDeafened)
      if (audio.mode != AudioManager.MODE_IN_COMMUNICATION) {
        audio.mode = AudioManager.MODE_IN_COMMUNICATION
      }
      requestCallAudioFocus(audio)
      webView.keepScreenOn = true
      return
    }

    webView.keepScreenOn = false
    abandonCallAudioFocus(audio)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      audio.clearCommunicationDevice()
      requestedCommunicationDeviceId = null
    }
    if (!callActive) return

    val restore = savedAudioMode ?: AudioManager.MODE_NORMAL
    // Do not overwrite another application's deliberate mode change if Telium
    // no longer owns communication mode by the time the call ends.
    if (audio.mode == AudioManager.MODE_IN_COMMUNICATION) {
      audio.mode = restore
    }
    savedAudioMode = null
    callActive = false
    callMuted = false
    callDeafened = false
    telecomCallManager.endCall()
    AndroidCallForegroundService.stop(this)
  }

  private fun publishAndroidCallControl(action: String) {
    val webView = teliumWebView ?: return
    val detail = JSONObject.quote(action)
    val script =
      "window.dispatchEvent(new CustomEvent('telium:android-call-control',{detail:$detail}));"
    webView.post { webView.evaluateJavascript(script, null) }
  }

  private fun requestCallAudioFocus(audio: AudioManager) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      if (audioFocusRequest != null) return
      val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
        .setAudioAttributes(
          AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build()
        )
        .build()
      if (audio.requestAudioFocus(request) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
        audioFocusRequest = request
      }
      return
    }

    if (legacyAudioFocusHeld) return
    @Suppress("DEPRECATION")
    val granted = audio.requestAudioFocus(
      null,
      AudioManager.STREAM_VOICE_CALL,
      AudioManager.AUDIOFOCUS_GAIN_TRANSIENT,
    )
    legacyAudioFocusHeld = granted == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
  }

  private fun abandonCallAudioFocus(audio: AudioManager) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      audioFocusRequest?.let { audio.abandonAudioFocusRequest(it) }
      audioFocusRequest = null
      return
    }

    if (!legacyAudioFocusHeld) return
    @Suppress("DEPRECATION")
    audio.abandonAudioFocus(null)
    legacyAudioFocusHeld = false
  }

  private fun responseExtra(
    requestId: String?,
    values: Map<String, Any> = emptyMap(),
  ): Map<String, Any> {
    if (requestId == null) return values
    return values + mapOf("request_id" to requestId)
  }

  private fun replyAudioRoutes(replyProxy: JavaScriptReplyProxy, requestId: String?) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
      reply(
        replyProxy,
        "routes",
        ok = true,
        extra = responseExtra(
          requestId,
          mapOf(
            "supported" to false,
            "selected" to "auto",
            "automatic_label" to "Automatic",
            "routes" to org.json.JSONArray(),
          ),
        ),
      )
      return
    }

    val audio = getSystemService(AudioManager::class.java)
    val available = audio.availableCommunicationDevices
    val ids = available.map { it.id }.toSet()
    requestedCommunicationDeviceId?.let { requested ->
      if (requested !in ids) requestedCommunicationDeviceId = null
    }

    val current = audio.communicationDevice
    val currentLabel = current?.let { communicationDeviceLabel(it) }
    val routes = org.json.JSONArray()
    val duplicateLabels = mutableMapOf<String, Int>()

    for (device in available) {
      val base = communicationDeviceLabel(device)
      val seen = (duplicateLabels[base] ?: 0) + 1
      duplicateLabels[base] = seen
      val label = if (seen == 1) base else "$base $seen"
      routes.put(
        JSONObject()
          .put("id", device.id.toString())
          .put("label", label)
          .put("kind", communicationDeviceKind(device))
      )
    }

    reply(
      replyProxy,
      "routes",
      ok = true,
      extra = responseExtra(
        requestId,
        mapOf(
          "supported" to true,
          "selected" to (requestedCommunicationDeviceId?.toString() ?: "auto"),
          "automatic_label" to if (currentLabel == null) "Automatic" else "Automatic · $currentLabel",
          "routes" to routes,
        ),
      ),
    )
  }

  private fun selectAudioRoute(
    replyProxy: JavaScriptReplyProxy,
    requestId: String?,
    routeId: String,
  ) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
      reply(
        replyProxy,
        "route",
        ok = false,
        message = "Audio output selection requires Android 12 or newer.",
        extra = responseExtra(requestId),
      )
      return
    }

    val audio = getSystemService(AudioManager::class.java)
    if (routeId == "auto") {
      audio.clearCommunicationDevice()
      requestedCommunicationDeviceId = null
      reply(
        replyProxy,
        "route",
        ok = true,
        extra = responseExtra(requestId, mapOf("selected" to "auto")),
      )
      return
    }

    val wanted = routeId.toIntOrNull()
    val device = audio.availableCommunicationDevices.firstOrNull { it.id == wanted }
    if (device == null) {
      requestedCommunicationDeviceId = null
      reply(
        replyProxy,
        "route",
        ok = false,
        message = "That audio output is no longer connected.",
        extra = responseExtra(requestId),
      )
      return
    }

    try {
      if (!audio.setCommunicationDevice(device)) {
        reply(
          replyProxy,
          "route",
          ok = false,
          message = "Android did not accept that audio output.",
          extra = responseExtra(requestId),
        )
        return
      }
      requestedCommunicationDeviceId = device.id
      reply(
        replyProxy,
        "route",
        ok = true,
        extra = responseExtra(requestId, mapOf("selected" to device.id.toString())),
      )
    } catch (error: Exception) {
      reply(
        replyProxy,
        "route",
        ok = false,
        message = error.message ?: "Could not switch audio output.",
        extra = responseExtra(requestId),
      )
    }
  }

  private fun communicationDeviceLabel(device: AudioDeviceInfo): String = when (device.type) {
    AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "Speaker"
    AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "Earpiece"
    AudioDeviceInfo.TYPE_WIRED_HEADSET,
    AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "Wired headset"
    AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
    AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
    AudioDeviceInfo.TYPE_BLE_HEADSET,
    AudioDeviceInfo.TYPE_BLE_SPEAKER,
    AudioDeviceInfo.TYPE_HEARING_AID -> "Bluetooth"
    AudioDeviceInfo.TYPE_USB_DEVICE,
    AudioDeviceInfo.TYPE_USB_ACCESSORY,
    AudioDeviceInfo.TYPE_USB_HEADSET -> "USB audio"
    else -> device.productName?.toString()?.takeIf { it.isNotBlank() } ?: "Audio device"
  }

  private fun communicationDeviceKind(device: AudioDeviceInfo): String = when (device.type) {
    AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "speaker"
    AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "earpiece"
    AudioDeviceInfo.TYPE_WIRED_HEADSET,
    AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "wired"
    AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
    AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
    AudioDeviceInfo.TYPE_BLE_HEADSET,
    AudioDeviceInfo.TYPE_BLE_SPEAKER,
    AudioDeviceInfo.TYPE_HEARING_AID -> "bluetooth"
    AudioDeviceInfo.TYPE_USB_DEVICE,
    AudioDeviceInfo.TYPE_USB_ACCESSORY,
    AudioDeviceInfo.TYPE_USB_HEADSET -> "usb"
    else -> "other"
  }

  /// Android WebView does not reliably download blob: URLs. DM attachments are
  /// decrypted inside the WebView, so handing the URL to DownloadManager would
  /// hand it an address Android cannot resolve.
  ///
  /// This bridge is deliberately narrower than addJavascriptInterface:
  /// AndroidX injects it only into Telium's own local Tauri origin, and messages
  /// from subframes are rejected as well. The native side can only ask Android
  /// for a user-chosen output document and stream bytes into that one URI.
  private fun installFileSaveBridge(webView: WebView) {
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return

    WebViewCompat.addWebMessageListener(
      webView,
      "teliumAndroidFileBridge",
      setOf("http://tauri.localhost", "https://tauri.localhost"),
      WebViewCompat.WebMessageListener { view, message, _, isMainFrame, replyProxy ->
        if (!isMainFrame) return@WebMessageListener

        if (message.type == WebMessageCompat.TYPE_ARRAY_BUFFER) {
          writeChunk(view, replyProxy, message.arrayBuffer)
          return@WebMessageListener
        }

        val raw = message.data ?: return@WebMessageListener
        val payload = try { JSONObject(raw) } catch (_: Exception) {
          reply(replyProxy, "error", ok = false, message = "Invalid save request.")
          return@WebMessageListener
        }

        when (payload.optString("op")) {
          "begin" -> beginSave(
            replyProxy,
            payload.optString("name"),
            payload.optString("mime"),
            payload.optLong("size", -1),
          )
          "chunk64" -> {
            val encoded = payload.optString("data")
            val bytes = try { Base64.decode(encoded, Base64.DEFAULT) } catch (_: Exception) {
              reply(replyProxy, "chunk", ok = false, message = "Invalid attachment data.")
              return@WebMessageListener
            }
            writeChunk(view, replyProxy, bytes)
          }
          "finish" -> finishSave(view, replyProxy)
          "abort" -> abortSave(view, replyProxy, null)
          else -> reply(replyProxy, "error", ok = false, message = "Unknown save operation.")
        }
      },
    )
  }

  private fun beginSave(replyProxy: JavaScriptReplyProxy, name: String, mime: String, size: Long) {
    if (pendingSave != null) {
      reply(replyProxy, "error", ok = false, message = "Another file is already being saved.")
      return
    }

    val safeName = name
      .replace(Regex("[\\/\\u0000-\\u001F]"), "_")
      .trim()
      .take(180)
      .ifBlank { "attachment" }
    val safeMime = mime.takeIf { it.contains("/") && it.length <= 120 } ?: "application/octet-stream"

    pendingSave = PendingSave(
      name = safeName,
      mime = safeMime,
      size = size.coerceAtLeast(0),
      reply = replyProxy,
    )

    val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      type = safeMime
      putExtra(Intent.EXTRA_TITLE, safeName)
    }

    try {
      saveDocument.launch(intent)
    } catch (error: Exception) {
      pendingSave = null
      reply(replyProxy, "error", ok = false, message = error.message ?: "Could not open Android's save dialog.")
    }
  }

  private fun writeChunk(webView: WebView, replyProxy: JavaScriptReplyProxy, bytes: ByteArray) {
    val pending = pendingSave
    val stream = pending?.stream
    if (pending == null || stream == null) {
      reply(replyProxy, "chunk", ok = false, message = "No file is ready to receive data.")
      return
    }

    saveExecutor.execute {
      try {
        stream.write(bytes)
        pending.written += bytes.size
        webView.post { reply(replyProxy, "chunk", ok = true) }
      } catch (error: Exception) {
        webView.post { abortSave(webView, replyProxy, error.message ?: "Could not write the file.") }
      }
    }
  }

  private fun finishSave(webView: WebView, replyProxy: JavaScriptReplyProxy) {
    val pending = pendingSave
    val stream = pending?.stream
    if (pending == null || stream == null) {
      reply(replyProxy, "error", ok = false, message = "No file is being saved.")
      return
    }

    saveExecutor.execute {
      try {
        stream.flush()
        stream.close()
        if (pending.size > 0 && pending.written != pending.size) {
          pending.uri?.let { contentResolver.delete(it, null, null) }
          pendingSave = null
          webView.post {
            reply(
              replyProxy,
              "error",
              ok = false,
              message = "The saved file was incomplete (${pending.written} of ${pending.size} bytes).",
            )
          }
          return@execute
        }
        pendingSave = null
        webView.post {
          reply(
            replyProxy,
            "done",
            ok = true,
            extra = mapOf("name" to pending.name, "bytes" to pending.written),
          )
        }
      } catch (error: Exception) {
        webView.post { abortSave(webView, replyProxy, error.message ?: "Could not finish saving the file.") }
      }
    }
  }

  private fun abortSave(webView: WebView, replyProxy: JavaScriptReplyProxy, message: String?) {
    val pending = pendingSave
    pendingSave = null
    try { pending?.stream?.close() } catch (_: Exception) {}
    try { pending?.uri?.let { contentResolver.delete(it, null, null) } } catch (_: Exception) {}
    webView.post {
      reply(
        replyProxy,
        if (message == null) "cancelled" else "error",
        ok = false,
        message = message,
      )
    }
  }

  private fun reply(
    proxy: JavaScriptReplyProxy,
    op: String,
    ok: Boolean,
    message: String? = null,
    extra: Map<String, Any> = emptyMap(),
  ) {
    val json = JSONObject()
      .put("op", op)
      .put("ok", ok)
    if (message != null) json.put("message", message)
    for ((key, value) in extra) json.put(key, value)
    proxy.postMessage(json.toString())
  }

  private fun publishSafeArea(webView: WebView, insets: WindowInsetsCompat) {
    val bars = insets.getInsets(
      WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
    )
    val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
    val density = resources.displayMetrics.density.coerceAtLeast(1f)

    fun cssPx(value: Int): String =
      String.format(Locale.US, "%.2fpx", value / density)

    val top = cssPx(bars.top)
    val right = cssPx(bars.right)
    val bottom = cssPx(bars.bottom)
    val left = cssPx(bars.left)
    val imeBottom = cssPx(ime.bottom)

    val script = """
      (() => {
        const root = document.documentElement;
        if (!root) return;
        root.style.setProperty('--android-safe-area-top', '$top');
        root.style.setProperty('--android-safe-area-right', '$right');
        root.style.setProperty('--android-safe-area-bottom', '$bottom');
        root.style.setProperty('--android-safe-area-left', '$left');
        root.style.setProperty('--android-ime-bottom', '$imeBottom');
        window.dispatchEvent(new CustomEvent('telium:android-insets'));
      })();
    """.trimIndent()

    webView.post { webView.evaluateJavascript(script, null) }
  }
}
