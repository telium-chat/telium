package chat.telium.desktop

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.content.ContextCompat
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import java.security.PrivateKey
import java.util.concurrent.TimeUnit
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Provider-independent native notification pipeline.
 *
 * FCM, UnifiedPush, and an app-resume recovery pass all call the same `drain`:
 * use the scoped background credential, fetch opaque inbox rows, decrypt them
 * with the Android-owned key, surface native notifications, and only then ack.
 */
internal object AndroidNotificationInbox {
  private const val TAG = "TeliumNotificationInbox"
  private const val PAGE_SIZE = 25
  private const val CONNECT_TIMEOUT_MS = 10_000
  private const val READ_TIMEOUT_MS = 10_000
  private const val RECOVERY_WORK = "telium-notification-inbox-recovery"

  private val executor = Executors.newSingleThreadExecutor()
  private val running = AtomicBoolean(false)

  fun drain(context: Context) {
    val app = context.applicationContext
    if (!running.compareAndSet(false, true)) return
    executor.execute {
      try {
        drainBlocking(app)
      } catch (error: IOException) {
        // Provider wakeups and app resume are recovery edges. A failed network
        // request remains unacked. Retry durable/transient failures even if the
        // app process dies or no second provider wake arrives.
        Log.w(TAG, "Inbox request failed; transient failures will be retried (${error.javaClass.simpleName})")
        if (shouldRetry(error)) scheduleRecovery(app)
      } catch (error: Exception) {
        Log.w(TAG, "Inbox processing failed (${error.javaClass.simpleName})")
        // Malformed local/server data remains unacked and can be retried on a
        // later explicit wake without creating an infinite background loop.
      } finally {
        running.set(false)
      }
    }
  }

  /**
   * Persist a network-constrained recovery pass with Android's scheduler.
   *
   * This is intentionally independent of FCM/UnifiedPush. Once a provider has
   * rung the doorbell, WorkManager owns the retry edge across process death,
   * Doze deferral, and temporary loss of network connectivity.
   */
  fun scheduleRecovery(context: Context) {
    val request = OneTimeWorkRequestBuilder<AndroidNotificationDrainWorker>()
      .setConstraints(
        Constraints.Builder()
          .setRequiredNetworkType(NetworkType.CONNECTED)
          .build(),
      )
      .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
      .build()
    WorkManager.getInstance(context.applicationContext).enqueueUniqueWork(
      RECOVERY_WORK,
      ExistingWorkPolicy.KEEP,
      request,
    )
  }

  internal fun drainForWorker(context: Context): Boolean {
    if (!running.compareAndSet(false, true)) return false
    return try {
      drainBlocking(context.applicationContext)
      true
    } catch (error: IOException) {
      Log.w(TAG, "Scheduled inbox request failed (${error.javaClass.simpleName})")
      !shouldRetry(error)
    } catch (error: Exception) {
      Log.w(TAG, "Scheduled inbox processing failed (${error.javaClass.simpleName})")
      true
    } finally {
      running.set(false)
    }
  }

  private fun drainBlocking(context: Context) {
    if (!canPostNotifications(context)) {
      Log.i(TAG, "Inbox drain skipped: system notifications are disabled")
      return
    }
    val registration = AndroidNotificationStore.activeRegistration(context) ?: run {
      Log.i(TAG, "Inbox drain skipped: no usable native registration")
      return
    }
    val privateKey = try {
      AndroidNotificationStore.privateKey(context, registration.scope)
    } catch (error: Exception) {
      Log.w(TAG, "Notification private key could not be loaded (${error.javaClass.simpleName})")
      return
    }
    ensureChannels(context)

    // Ack by monotonically ordered cursor. If one row cannot be decrypted or
    // surfaced, stop at it; acknowledging a later cursor would silently delete
    // the failed row as well.
    repeat(8) {
      val page = request(
        registration,
        "GET",
        "/_telium/v1/notifications?limit=$PAGE_SIZE",
      )
      val notifications = page.optJSONArray("notifications") ?: JSONArray()
      if (notifications.length() == 0) return

      var acknowledgedThrough: String? = null
      for (index in 0 until notifications.length()) {
        // A non-object row is malformed server data. Stop rather than looping
        // back to the same page forever or acknowledging past it.
        val item = notifications.optJSONObject(index) ?: return
        val id = item.optString("id")
        if (id.isBlank()) return

        val descriptor = try {
          decrypt(privateKey, registration, item)
        } catch (error: Exception) {
          // Log only the failure class, never credentials, ciphertext or content.
          Log.w(TAG, "Inbox decryption failed; later rows remain pending (${error.javaClass.simpleName})")
          // Leave this and every later row in the inbox. A key mismatch or
          // tampered envelope must never be converted into a misleading alert.
          if (acknowledgedThrough != null) ack(registration, acknowledgedThrough)
          return
        }
        val dmHint = descriptor.optString("kind") == "dm_hint"
        val quietDmHint = dmHint && descriptor.optInt("notify", 0) != 1
        val dmAlertsDisabled = dmHint
          && !AndroidNotificationStore.dmNotifications(context, registration.scope)
        if (quietDmHint || dmAlertsDisabled) {
          // Quiet application frames (receipts, reactions, edits, etc.) take
          // exactly the same encrypted server path as messages, then disappear
          // only here on the device. The same is true when the user disabled
          // DM alerts: servers never learn that preference.
          //
          // Dropping the row still acknowledges it. The alternative -- leaving
          // it pending -- would mean the next wake re-fetches a row we have
          // already decided not to show, forever, and the cursor would never
          // advance past the first reaction anybody sent.
          acknowledgedThrough = id
          continue
        }
        if (!post(context, registration.scope, id, item, descriptor)) {
          if (acknowledgedThrough != null) ack(registration, acknowledgedThrough)
          return
        }
        acknowledgedThrough = id
      }

      if (acknowledgedThrough == null) return
      ack(registration, acknowledgedThrough)
      if (notifications.length() < PAGE_SIZE) return
    }
  }

  private fun decrypt(
    privateKey: PrivateKey,
    registration: AndroidNotificationStore.Registration,
    item: JSONObject,
  ): JSONObject {
    val origin = item.optString("origin")
    val sourceId = item.optString("source_id")
    val kind = item.optString("kind")
    require(origin.isNotBlank() && sourceId.isNotBlank() && kind.isNotBlank())
    val guildId = if (item.isNull("guild_id")) null else item.optString("guild_id")
    val ciphertext = item.optJSONObject("ciphertext")
      ?: throw IllegalArgumentException("Notification envelope is missing.")
    val envelope = if (kind == "dm_hint") {
      ciphertext.optJSONObject("envelope")
        ?: throw IllegalArgumentException("DM notification envelope is missing.")
    } else {
      ciphertext
    }
    val descriptor = AndroidNotificationCrypto.decrypt(
      privateKey = privateKey,
      userId = registration.scope.userId,
      deviceId = registration.scope.deviceId,
      origin = origin,
      sourceId = sourceId,
      guildId = guildId,
      kind = kind,
      envelope = envelope,
    )

    if (kind == "dm_hint") {
      val conversationId = ciphertext.optString("conversation_id")
      val sender = ciphertext.optString("sender")
      require(conversationId.isNotBlank() && conversationId.length <= 1024) {
        "DM notification conversation is invalid."
      }
      require(sender.isNotBlank() && sender.length <= 1024) {
        "DM notification sender is invalid."
      }
      val senderTitle = sender.removePrefix("@").substringBefore(':').ifBlank { sender }
      descriptor
        .put("title", senderTitle.take(200))
        .put("body", "Encrypted message")
        .put(
          "destination",
          JSONObject()
            .put("type", "conversation")
            .put("conversation_id", conversationId),
        )
    }
    return descriptor
  }

  private fun post(
    context: Context,
    scope: AndroidNotificationStore.Scope,
    inboxId: String,
    row: JSONObject,
    descriptor: JSONObject,
  ): Boolean {
    if (!canPostNotifications(context)) return false
    val kind = descriptor.optString("kind")
    val createdAt = descriptor.optLong("created_at")
    val now = System.currentTimeMillis()
    if (!AndroidNotificationUrgency.shouldDisplay(kind, createdAt, now)) {
      // Treat a stale call as successfully consumed. Leaving it unacked would
      // make every later wake revisit the same call and block newer rows.
      return true
    }
    val rawTitle = descriptor.optString("title", "Telium").take(200).ifBlank { "Telium" }
    val rawBody = descriptor.optString("body").take(1000)
    val previewMode = AndroidNotificationStore.previewMode(context, scope)
    val visible = AndroidNotificationPreview.render(
      mode = previewMode,
      title = rawTitle,
      body = rawBody,
      genericBody = AndroidNotificationPreview.genericBody(kind),
    )
    val destination = descriptor.optJSONObject("destination")
    val destinationType = destination?.optString("type")
    val groupKey = AndroidNotificationConversation.groupKey(
      scopeId = scope.id,
      destinationType = destinationType,
      guildOrigin = destination?.optString("guild_origin"),
      guildId = destination?.optString("guild_id"),
      channelId = destination?.optString("channel_id"),
      conversationId = destination?.optString("conversation_id"),
    )

    // `coalesce_key` is the account home's blinded bucket id: a truncated hash
    // that two rows from the same conversation or channel share and that
    // nobody downstream can turn back into a conversation. Rows carrying the
    // same one belong together in the shade.
    //
    // It is routing metadata and is trusted as such and no further. Unlike the
    // origin, source id, guild and kind, it is *not* inside the envelope's
    // associated data, so a hostile or simply buggy account home can put two
    // conversations in one bucket or split one across two and nothing here
    // would notice. What that costs is a shade that groups wrongly. It cannot
    // cost a disclosure: every visible word comes out of the sealed
    // descriptor, which that same home cannot read or forge. Making the key
    // verifiable would mean carrying the conversation id in the clear beside
    // the ciphertext, handing the account home exactly the fact the blinding
    // exists to keep from it, so the grouping stays cosmetic and untrusted on
    // purpose. A row without a key keeps the old behaviour and stands alone
    // under its own inbox id.
    val coalesceKey = if (row.isNull("coalesce_key")) {
      null
    } else {
      row.optString("coalesce_key").takeIf { it.isNotBlank() && it.length <= 256 }
    }
    val tag = coalesceKey ?: inboxId
    val coalesced = row.optInt("coalesced", 0).coerceAtLeast(0)

    val intent = Intent(context, AndroidNotificationTapActivity::class.java).apply {
      putExtra(AndroidNotificationTapStore.EXTRA_USER_ID, scope.userId)
      putExtra(AndroidNotificationTapStore.EXTRA_NOTIFICATION_TAG, inboxId)
      if (destination != null) {
        putExtra(AndroidNotificationTapStore.EXTRA_DESTINATION, destination.toString())
      }
    }
    // The request code is deliberately the bucket and not the row. Every one of
    // these intents targets the same component and differs only in extras,
    // which PendingIntent equality ignores, so the request code is the only
    // thing that decides whether two rows share one PendingIntent -- and with
    // FLAG_UPDATE_CURRENT, sharing means the newer row's extras win. That is
    // exactly the semantics wanted now that the tag is the bucket too: the
    // older notification is no longer in the shade to be tapped, and both rows
    // route to the same conversation anyway, so keeping a distinct code per row
    // would only accumulate system-held PendingIntents for notifications that
    // no longer exist. Two different buckets whose hashes collide would share
    // a tap target, which misroutes a tap to another of this account's own
    // conversations -- the same cosmetic failure the untrusted bucket key
    // already admits to, and no worse than the per-row hash it replaces.
    val pending = PendingIntent.getActivity(
      context,
      tag.hashCode(),
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    val bucket = AndroidNotificationChannels.forKind(kind)
    val category = when (bucket) {
      AndroidNotificationChannels.Bucket.CALL -> NotificationCompat.CATEGORY_CALL
      AndroidNotificationChannels.Bucket.ACCOUNT -> NotificationCompat.CATEGORY_STATUS
      else -> NotificationCompat.CATEGORY_MESSAGE
    }
    val priority = if (bucket.urgent) {
      NotificationCompat.PRIORITY_HIGH
    } else {
      NotificationCompat.PRIORITY_DEFAULT
    }

    val builder = NotificationCompat.Builder(context, bucket.id)
      // Notification small icons are masks, not adaptive launcher icons. Telium
      // already ships this monochrome vector down to minSdk 24.
      .setSmallIcon(R.drawable.ic_launcher_monochrome)
      .setContentTitle(visible.title)
      .setContentText(visible.body)
      .setContentIntent(pending)
      .setAutoCancel(true)
      .setCategory(category)
      .setPriority(priority)

    if (coalesced > 0) {
      // This row stands in for notifications the account home folded into the
      // same bucket and never sent, so without a count the user is shown one
      // alert for what was several events and has no way to tell. A bare number
      // restores that and leaks nothing the notification did not already
      // concede: the shade is already saying this bucket is active, and how
      // many times is weaker than the arrival timing a push provider watches
      // anyway. It stays a number for that reason -- no senders, no subjects,
      // no "and 3 more from Alice", because each of those would be content the
      // account home was never supposed to be able to supply.
      builder.setSubText("+$coalesced earlier")
    }
    if (bucket.contributesToUnreadBadge) {
      // Android launchers derive supported badge counts from active
      // notifications. Each message/mention row represents one unread alert;
      // calls and account/security events deliberately do not inflate it.
      //
      // A coalesced row stands for more than one alert, so it says so. The two
      // rules have to agree on a single number because there is only one to
      // give: whichever ran second would otherwise silently erase the other,
      // and the badge would read 1 for a row the shade is describing as five.
      builder.setNumber(if (coalesced > 0) coalesced + 1 else 1)
    }

    if (
      bucket == AndroidNotificationChannels.Bucket.CALL
        && destinationType == "conversation"
    ) {
      val answerIntent = Intent(context, AndroidNotificationTapActivity::class.java).apply {
        putExtra(AndroidNotificationTapStore.EXTRA_USER_ID, scope.userId)
        putExtra(AndroidNotificationTapStore.EXTRA_DESTINATION, destination.toString())
        putExtra(
          AndroidNotificationTapStore.EXTRA_ACTION,
          AndroidNotificationDestination.ACTION_ANSWER_CALL,
        )
        putExtra(AndroidNotificationTapStore.EXTRA_NOTIFICATION_TAG, inboxId)
      }
      val answerPending = PendingIntent.getActivity(
        context,
        inboxId.hashCode() * 31 + 1,
        answerIntent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
      val declineIntent = Intent(context, AndroidNotificationActionReceiver::class.java).apply {
        action = AndroidNotificationActionReceiver.ACTION_DECLINE_CALL
        putExtra(AndroidNotificationActionReceiver.EXTRA_NOTIFICATION_TAG, inboxId)
      }
      val declinePending = PendingIntent.getBroadcast(
        context,
        inboxId.hashCode() * 31 + 2,
        declineIntent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
      builder
        .addAction(R.drawable.ic_launcher_monochrome, "Decline", declinePending)
        .addAction(R.drawable.ic_launcher_monochrome, "Answer", answerPending)
    }

    AndroidNotificationUrgency.timeoutAfterMs(kind, createdAt, now)?.let { timeout ->
      builder
        .setTimeoutAfter(timeout)
        .setOnlyAlertOnce(true)
    }

    if (groupKey != null) {
      val sender = Person.Builder()
        .setName(visible.title)
        .build()
      val style = NotificationCompat.MessagingStyle(
        Person.Builder().setName("Telium").build(),
      ).addMessage(
        visible.body,
        createdAt.takeIf { it > 0L } ?: now,
        sender,
      )
      val descriptorContext = descriptor.optJSONObject("context")
      AndroidNotificationConversation.conversationTitle(
        previewMode = previewMode,
        destinationType = destinationType,
        guildName = descriptorContext?.optString("guild_name"),
        channelName = descriptorContext?.optString("channel_name"),
      )?.let(style::setConversationTitle)
      builder
        .setStyle(style)
        .setGroup(groupKey)
    } else {
      builder.setStyle(NotificationCompat.BigTextStyle().bigText(visible.body))
    }

    return try {
      // Tagging by bucket is what makes the newest notification for a
      // conversation replace the older one instead of stacking beside it. A
      // stable tag still does the job it did before: a retry after an ack
      // network failure updates the existing OS notification rather than
      // duplicating it, because the replayed row lands on the same tag.
      NotificationManagerCompat.from(context).notify(tag, 0, builder.build())
      true
    } catch (_: SecurityException) {
      Log.w(TAG, "Android rejected notification display; row remains pending")
      false
    }
  }

  private fun ensureChannels(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(NotificationManager::class.java)
    val channels = AndroidNotificationChannels.Bucket.values().map { bucket ->
      NotificationChannel(
        bucket.id,
        bucket.label,
        if (bucket.urgent) {
          NotificationManager.IMPORTANCE_HIGH
        } else {
          NotificationManager.IMPORTANCE_DEFAULT
        },
      ).apply {
        description = bucket.description
        setShowBadge(bucket.contributesToUnreadBadge)
      }
    }
    // Re-creating an existing Android channel is safe: Android preserves the
    // user's importance/sound/vibration choices while allowing Telium to keep
    // labels and descriptions current.
    manager.createNotificationChannels(channels)
  }

  private fun canPostNotifications(context: Context): Boolean {
    if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return false
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
    return ContextCompat.checkSelfPermission(
      context,
      Manifest.permission.POST_NOTIFICATIONS,
    ) == PackageManager.PERMISSION_GRANTED
  }

  private fun ack(
    registration: AndroidNotificationStore.Registration,
    through: String,
  ) {
    request(
      registration,
      "POST",
      "/_telium/v1/notifications/ack",
      JSONObject().put("through", through),
    )
  }

  private fun request(
    registration: AndroidNotificationStore.Registration,
    method: String,
    path: String,
    body: JSONObject? = null,
  ): JSONObject {
    val url = URL(registration.scope.homeBase + path)
    val connection = (url.openConnection() as HttpURLConnection).apply {
      requestMethod = method
      connectTimeout = CONNECT_TIMEOUT_MS
      readTimeout = READ_TIMEOUT_MS
      instanceFollowRedirects = false
      setRequestProperty(
        "Authorization",
        "Telium-Notification ${registration.backgroundToken}",
      )
      setRequestProperty("Accept", "application/json")
      if (body != null) {
        doOutput = true
        setRequestProperty("Content-Type", "application/json")
      }
    }

    try {
      if (body != null) {
        connection.outputStream.use { stream ->
          stream.write(body.toString().toByteArray(StandardCharsets.UTF_8))
        }
      }
      val status = connection.responseCode
      val stream = if (status in 200..299) connection.inputStream else connection.errorStream
      val text = stream?.bufferedReader(StandardCharsets.UTF_8)?.use { it.readText() }.orEmpty()
      if (status !in 200..299) {
        Log.w(TAG, "Notification inbox returned HTTP $status")
        throw NotificationHttpException(status)
      }
      return if (text.isBlank()) JSONObject() else JSONObject(text)
    } finally {
      connection.disconnect()
    }
  }

  private fun shouldRetry(error: IOException): Boolean = when (error) {
    is NotificationHttpException -> AndroidNotificationRecovery.shouldRetry(error.status)
    else -> AndroidNotificationRecovery.shouldRetry(null)
  }

  private class NotificationHttpException(val status: Int) :
    IOException("Notification inbox returned HTTP $status")
}

internal object AndroidNotificationRecovery {
  fun shouldRetry(httpStatus: Int?): Boolean = when {
    httpStatus == null -> true
    httpStatus == 408 || httpStatus == 429 -> true
    httpStatus >= 500 -> true
    else -> false
  }
}

/** Durable notification inbox recovery after an opaque provider wake. */
class AndroidNotificationDrainWorker(
  appContext: Context,
  params: WorkerParameters,
) : Worker(appContext, params) {
  override fun doWork(): Result = if (
    AndroidNotificationInbox.drainForWorker(applicationContext)
  ) {
    Result.success()
  } else {
    Result.retry()
  }
}
