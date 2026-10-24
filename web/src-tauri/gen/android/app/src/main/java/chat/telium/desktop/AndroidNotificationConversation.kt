package chat.telium.desktop

import java.nio.charset.StandardCharsets
import java.security.MessageDigest

/**
 * Small, privacy-safe bits of Android conversation notification metadata.
 *
 * Group keys are deliberately opaque: NotificationManager does not need raw
 * guild/channel/conversation ids, and future multi-account support must not
 * accidentally merge alerts from two signed-in identities.
 */
internal object AndroidNotificationConversation {
  fun groupKey(
    scopeId: String,
    destinationType: String?,
    guildOrigin: String?,
    guildId: String?,
    channelId: String?,
    conversationId: String?,
  ): String? {
    val destination = when (destinationType) {
      "guild_message" -> {
        val origin = guildOrigin?.takeIf { it.isNotBlank() } ?: return null
        val guild = guildId?.takeIf { it.isNotBlank() } ?: return null
        val channel = channelId?.takeIf { it.isNotBlank() } ?: return null
        "guild\u0000$origin\u0000$guild\u0000$channel"
      }
      "conversation" -> {
        val conversation = conversationId?.takeIf { it.isNotBlank() } ?: return null
        "dm\u0000$conversation"
      }
      else -> return null
    }
    val material = "$scopeId\u0000$destination".toByteArray(StandardCharsets.UTF_8)
    val digest = MessageDigest.getInstance("SHA-256").digest(material)
    val hex = buildString(digest.size * 2) {
      for (byte in digest) {
        val value = byte.toInt() and 0xff
        append(HEX[value ushr 4])
        append(HEX[value and 0x0f])
      }
    }
    return "telium_conversation_$hex"
  }

  fun conversationTitle(
    previewMode: String,
    destinationType: String?,
    guildName: String?,
    channelName: String?,
  ): String? {
    // Sender-only and hidden modes intentionally do not reveal which guild or
    // channel generated an alert through Android's conversation chrome.
    if (AndroidNotificationPreview.normalize(previewMode) != AndroidNotificationPreview.FULL) {
      return null
    }
    if (destinationType != "guild_message") return null

    val guild = guildName?.trim()?.takeIf { it.isNotBlank() }
    val channel = channelName?.trim()?.takeIf { it.isNotBlank() }
    return when {
      channel != null && guild != null -> "#$channel · $guild"
      channel != null -> "#$channel"
      guild != null -> guild
      else -> null
    }
  }

  private const val HEX = "0123456789abcdef"
}
