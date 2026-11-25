package chat.telium.desktop

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager

/**
 * What Android itself expects of an app in a call, beyond holding communication mode:
 *
 *  - Audio focus is held *with a listener*. A phone call, alarm or navigation prompt taking it
 *    reports `focus_lost` to the client (which holds the microphone) and `focus_gained` when it
 *    comes back, at which point communication mode is re-asserted.
 *  - Headsets that connect mid-call are used, the way the system dialer does, unless the user
 *    picked an output; an output that disappears falls back to automatic. Either way the client
 *    hears `routes_changed` so an open output picker stays truthful.
 *  - On the earpiece with no video, the proximity sensor turns the screen off against the ear,
 *    instead of the screen staying lit for the whole call.
 *
 * Holds no Telium state. Events go back through [onControl] as plain action names.
 */
internal class AndroidCallAudio(
  private val context: Context,
  private val onControl: (String) -> Unit,
) {
  private val audio = context.getSystemService(AudioManager::class.java)
  private val main = Handler(Looper.getMainLooper())

  /** The output the user chose, or null for automatic. */
  var requestedDeviceId: Int? = null

  private var active = false
  private var video = false
  private var focusRequest: AudioFocusRequest? = null
  private var legacyFocusHeld = false
  private var heldForFocusLoss = false
  private var proximity: PowerManager.WakeLock? = null
  private var deviceCallbackRegistered = false
  private var communicationListener: Any? = null

  private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
    main.post { onFocusChange(change) }
  }

  private val deviceCallback = object : AudioDeviceCallback() {
    override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) {
      main.post { onDevicesAdded(addedDevices) }
    }

    override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) {
      main.post { onDevicesRemoved(removedDevices) }
    }
  }

  fun start(withVideo: Boolean) {
    video = withVideo
    if (!active) {
      active = true
      heldForFocusLoss = false
      audio.registerAudioDeviceCallback(deviceCallback, main)
      deviceCallbackRegistered = true
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        val listener = AudioManager.OnCommunicationDeviceChangedListener { updateProximity() }
        audio.addOnCommunicationDeviceChangedListener(context.mainExecutor, listener)
        communicationListener = listener
      }
    }
    requestFocus()
    updateProximity()
  }

  fun setVideo(withVideo: Boolean) {
    if (video == withVideo) return
    video = withVideo
    updateProximity()
  }

  fun stop() {
    active = false
    video = false
    heldForFocusLoss = false
    abandonFocus()
    releaseProximity()
    if (deviceCallbackRegistered) {
      audio.unregisterAudioDeviceCallback(deviceCallback)
      deviceCallbackRegistered = false
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      (communicationListener as? AudioManager.OnCommunicationDeviceChangedListener)?.let {
        audio.removeOnCommunicationDeviceChangedListener(it)
      }
    }
    communicationListener = null
    requestedDeviceId = null
  }

  /** After the user picks an output. */
  fun routeChanged() = updateProximity()

  private fun requestFocus() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      if (focusRequest != null) return
      val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
        .setAudioAttributes(
          AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build(),
        )
        .setOnAudioFocusChangeListener(focusListener, main)
        .build()
      if (audio.requestAudioFocus(request) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
        focusRequest = request
      }
      return
    }
    if (legacyFocusHeld) return
    @Suppress("DEPRECATION")
    val granted = audio.requestAudioFocus(
      focusListener,
      AudioManager.STREAM_VOICE_CALL,
      AudioManager.AUDIOFOCUS_GAIN_TRANSIENT,
    )
    legacyFocusHeld = granted == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
  }

  private fun abandonFocus() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      focusRequest?.let { audio.abandonAudioFocusRequest(it) }
      focusRequest = null
      return
    }
    if (!legacyFocusHeld) return
    @Suppress("DEPRECATION")
    audio.abandonAudioFocus(focusListener)
    legacyFocusHeld = false
  }

  private fun onFocusChange(change: Int) {
    if (!active) return
    when (change) {
      AudioManager.AUDIOFOCUS_LOSS,
      AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
        if (change == AudioManager.AUDIOFOCUS_LOSS) {
          // Permanently lost: drop the request so the next resume or state update asks again.
          focusRequest = null
          legacyFocusHeld = false
        }
        if (!heldForFocusLoss) {
          heldForFocusLoss = true
          onControl("focus_lost")
        }
      }
      AudioManager.AUDIOFOCUS_GAIN -> {
        if (audio.mode != AudioManager.MODE_IN_COMMUNICATION) {
          audio.mode = AudioManager.MODE_IN_COMMUNICATION
        }
        if (heldForFocusLoss) {
          heldForFocusLoss = false
          onControl("focus_gained")
        }
      }
      // A transient duck (a notification sound) needs nothing from a call.
    }
  }

  private fun onDevicesAdded(added: Array<out AudioDeviceInfo>) {
    if (!active) return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && requestedDeviceId == null) {
      val addedIds = added.map { it.id }.toSet()
      audio.availableCommunicationDevices
        .filter { it.id in addedIds && isPersonalOutput(it.type) }
        .maxByOrNull { preference(it.type) }
        ?.let { audio.setCommunicationDevice(it) }
    }
    onControl("routes_changed")
    updateProximity()
  }

  private fun onDevicesRemoved(removed: Array<out AudioDeviceInfo>) {
    if (!active) return
    val removedIds = removed.map { it.id }.toSet()
    if (requestedDeviceId != null && requestedDeviceId in removedIds) {
      requestedDeviceId = null
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) audio.clearCommunicationDevice()
    }
    onControl("routes_changed")
    updateProximity()
  }

  private fun isPersonalOutput(type: Int): Boolean = preference(type) > 0

  /** Higher wins when several connect at once; zero means "not a headset". */
  private fun preference(type: Int): Int = when (type) {
    AudioDeviceInfo.TYPE_WIRED_HEADSET,
    AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
    AudioDeviceInfo.TYPE_USB_HEADSET -> 4
    AudioDeviceInfo.TYPE_BLE_HEADSET -> 3
    AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> 2
    AudioDeviceInfo.TYPE_HEARING_AID -> 1
    else -> 0
  }

  private fun onEarpiece(): Boolean {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      return audio.communicationDevice?.type == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
    }
    // Before Android 12 there is no reliable way to tell; never blank a screen by guesswork.
    return false
  }

  private fun updateProximity() {
    if (active && !video && onEarpiece()) acquireProximity() else releaseProximity()
  }

  private fun acquireProximity() {
    if (proximity?.isHeld == true) return
    val power = context.getSystemService(PowerManager::class.java) ?: return
    if (!power.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)) return
    proximity = power.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "telium:call-proximity")
      .apply {
        setReferenceCounted(false)
        acquire()
      }
  }

  private fun releaseProximity() {
    proximity?.let {
      if (it.isHeld) it.release(PowerManager.RELEASE_FLAG_WAIT_FOR_NO_PROXIMITY)
    }
    proximity = null
  }
}
