package chat.telium.desktop

import android.content.Context
import android.net.Uri
import android.os.Build
import android.telecom.DisconnectCause
import android.util.Log
import androidx.core.telecom.CallAttributesCompat
import androidx.core.telecom.CallControlScope
import androidx.core.telecom.CallsManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * Registers an already-authenticated Telium WebRTC call with Android Telecom.
 *
 * This layer intentionally knows no Telium channel IDs, users, credentials, or
 * media keys. The WebView only tells it whether a call exists. Telecom can ask
 * Telium to end that call, which is handed back to the authenticated web client
 * through [onControl].
 */
class AndroidTelecomCallManager(
  context: Context,
  private val onControl: (String) -> Unit,
) {
  private val applicationContext = context.applicationContext
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
  private val callsManager by lazy { CallsManager(applicationContext) }

  @Volatile
  private var callJob: Job? = null

  @Volatile
  private var callControl: CallControlScope? = null

  @Volatile
  private var registered = false

  @Volatile
  private var ending = false

  @Volatile
  private var restartAfterEnd = false

  @Synchronized
  fun startCall() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    if (callJob != null) {
      if (ending) restartAfterEnd = true
      return
    }

    ending = false
    restartAfterEnd = false

    val job = scope.launch(start = CoroutineStart.LAZY) {
      try {
        if (!registered) {
          callsManager.registerAppWithTelecom(CallsManager.CAPABILITY_BASELINE)
          registered = true
        }

        val attributes = CallAttributesCompat(
          displayName = "Telium call",
          address = Uri.parse("telium:call"),
          direction = CallAttributesCompat.DIRECTION_OUTGOING,
          callType = CallAttributesCompat.CALL_TYPE_AUDIO_CALL,
          // Telium does not advertise hold until the WebRTC layer can
          // synchronously stop both capture and playback for Telecom.
          callCapabilities = 0,
        )

        callsManager.addCall(
          callAttributes = attributes,
          onAnswer = {
            // Active Telium calls are registered after the authenticated client
            // has already joined, so Telecom should never need to answer one.
          },
          onDisconnect = {
            onControl(CONTROL_DISCONNECT)
          },
          onSetActive = {
            // The WebRTC session is already active. Telecom owns only the
            // platform call lifecycle, not Telium media state.
          },
          onSetInactive = {
            // SUPPORTS_SET_INACTIVE is deliberately absent. If an OEM invokes
            // this callback anyway, ending the call is safer than claiming it
            // is held while WebRTC continues transmitting.
            onControl(CONTROL_DISCONNECT)
          },
        ) {
          callControl = this
          scope.launch {
            try {
              setActive()
            } catch (error: Exception) {
              Log.w(TAG, "Could not mark Telium call active in Telecom", error)
            }
          }
        }
      } catch (error: Exception) {
        // Telecom integration is additive. The existing foreground service and
        // WebRTC call remain usable if an OEM rejects self-managed calling.
        Log.w(TAG, "Android Telecom call registration failed", error)
      } finally {
        val restart = synchronized(this@AndroidTelecomCallManager) {
          callControl = null
          callJob = null
          ending = false
          val pending = restartAfterEnd
          restartAfterEnd = false
          pending
        }
        if (restart) startCall()
      }
    }
    callJob = job
    job.start()
  }

  @Synchronized
  fun endCall() {
    ending = true
    restartAfterEnd = false
    val job = callJob ?: return
    val control = callControl
    if (control == null) {
      job.cancel()
      return
    }

    scope.launch {
      try {
        control.disconnect(DisconnectCause(DisconnectCause.LOCAL))
      } catch (error: Exception) {
        Log.w(TAG, "Could not disconnect Telium call from Telecom", error)
        job.cancel()
      }
    }
  }

  @Synchronized
  fun close() {
    ending = true
    restartAfterEnd = false
    callJob?.cancel()
    callJob = null
    callControl = null
    scope.cancel()
  }

  companion object {
    const val CONTROL_DISCONNECT = "disconnect"
    private const val TAG = "TeliumTelecom"
  }
}
