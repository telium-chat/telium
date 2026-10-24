package chat.telium.desktop

/**
 * Preview privacy is applied after descriptor decryption, immediately before
 * Android receives the visible title/body. The encrypted inbox itself remains
 * unchanged so changing this preference never requires re-encryption.
 */
internal object AndroidNotificationPreview {
  const val FULL = "full"
  const val SENDER = "sender"
  const val HIDDEN = "hidden"

  data class Visible(
    val title: String,
    val body: String,
  )

  fun normalize(mode: String?): String = when (mode) {
    SENDER -> SENDER
    HIDDEN -> HIDDEN
    else -> FULL
  }

  fun render(
    mode: String?,
    title: String,
    body: String,
    genericBody: String,
  ): Visible = when (normalize(mode)) {
    SENDER -> Visible(
      title = title.ifBlank { "Telium" },
      body = genericBody,
    )
    HIDDEN -> Visible(
      title = "Telium",
      body = genericBody,
    )
    else -> Visible(
      title = title.ifBlank { "Telium" },
      body = body,
    )
  }

  /// Twin of `genericNotificationBody` in web/src/lib/notification-preview.js.
  /// The web client redacts its own local notifications; this inbox redacts
  /// after decrypting in the background. One synced account preference drives
  /// both, so the same preference has to produce the same words on a laptop
  /// and on a lock screen -- keep the two lists in step by hand.
  ///
  /// "Encrypted message" is the literal truth rather than a euphemism: the
  /// account home could not have authored a richer body for a DM if it had
  /// wanted to, because all it holds is MLS ciphertext.
  fun genericBody(kind: String): String = when (kind) {
    "encrypted_message" -> "Encrypted message"
    "mention" -> "New mention"
    "reply" -> "New reply"
    "dm_hint" -> "Encrypted message"
    "call", "incoming_call" -> "Incoming call"
    "account", "account_security", "security", "migration" -> "Account alert"
    else -> "New message"
  }
}
