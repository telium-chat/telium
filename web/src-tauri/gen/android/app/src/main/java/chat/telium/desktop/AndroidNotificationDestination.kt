package chat.telium.desktop

/**
 * Native validation for notification tap destinations. Keep this in lockstep
 * with the web client's canonical Android notification navigation schema.
 */
internal object AndroidNotificationDestination {
  private const val MAX_FIELD_LENGTH = 1024
  const val ACTION_ANSWER_CALL = "answer_call"

  fun isValid(
    type: String?,
    guildOrigin: String? = null,
    guildId: String? = null,
    channelId: String? = null,
    messageId: String? = null,
    conversationId: String? = null,
  ): Boolean = when (type) {
    "conversation" -> bounded(conversationId)
    "guild_message" -> listOf(guildOrigin, guildId, channelId, messageId).all(::bounded)
    else -> false
  }

  fun isValidAction(action: String?, destinationType: String?): Boolean = when {
    action.isNullOrBlank() -> true
    action == ACTION_ANSWER_CALL -> destinationType == "conversation"
    else -> false
  }

  private fun bounded(value: String?): Boolean =
    !value.isNullOrBlank() && value.length <= MAX_FIELD_LENGTH
}
