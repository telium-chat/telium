package chat.telium.desktop

/**
 * Stable Android notification channel taxonomy.
 *
 * This object has no Android framework dependency on purpose, so the mapping
 * from Telium descriptor kinds to user-visible channel buckets can be unit
 * tested on an ordinary JVM.
 */
internal object AndroidNotificationChannels {
  enum class Bucket(
    val id: String,
    val label: String,
    val description: String,
    val urgent: Boolean,
    val contributesToUnreadBadge: Boolean,
  ) {
    MESSAGE(
      id = "telium_messages",
      label = "Messages",
      description = "Routine messages delivered while Telium is in the background",
      urgent = false,
      contributesToUnreadBadge = true,
    ),
    MENTION(
      id = "telium_mentions",
      label = "Mentions and replies",
      description = "Direct mentions and replies that need your attention",
      urgent = true,
      contributesToUnreadBadge = true,
    ),
    CALL(
      id = "telium_calls",
      label = "Calls",
      description = "Incoming Telium calls",
      urgent = true,
      contributesToUnreadBadge = false,
    ),
    ACCOUNT(
      id = "telium_account_security",
      label = "Account and security",
      description = "Account, migration, and security alerts",
      urgent = true,
      contributesToUnreadBadge = false,
    ),
  }

  /**
   * Unknown future kinds fall back to routine messages. A new server-side
   * descriptor must opt into a louder channel rather than accidentally gaining
   * urgency merely because an older client does not recognise it yet.
   */
  fun forKind(kind: String): Bucket = when (kind) {
    "mention", "reply" -> Bucket.MENTION
    // An encrypted direct message is routine, and it says so in its own arm
    // rather than arriving here through the `else`. Two kinds land on that
    // arm because two mechanisms queue direct-message wakes: `encrypted_message`
    // from the account home, which sees a plaintext "worth a ring" bit on the
    // frame, and `dm_hint` from the sealed per-device path, which a killed
    // process can read without MLS running. They describe the same event to a
    // person, so they share a bucket -- but each is named, because the
    // fallback below means "a kind this build has never heard of", and a
    // classification that was actually decided must not be mistakable for one
    // that was never made.
    //
    // Routine is the only honest answer available. The account home that
    // queued the wake holds MLS ciphertext for the conversation and nothing
    // else, so it cannot tell a DM that mentions you apart from a DM that says
    // "ok" -- telling them apart is precisely the plaintext read this design
    // exists to make impossible. Putting every DM on the high-importance
    // mentions channel would therefore not be a statement about urgency, it
    // would be a guess dressed as one, and it would make every "ok" interrupt
    // like a mention until the user gave up and silenced the channel that also
    // carries their real mentions. Anyone who does want every DM loud can
    // raise this channel in Android settings, and Android keeps that choice
    // when Telium re-creates its channel definitions.
    "encrypted_message", "dm_hint" -> Bucket.MESSAGE
    "call", "incoming_call" -> Bucket.CALL
    "account", "account_security", "security", "migration" -> Bucket.ACCOUNT
    else -> Bucket.MESSAGE
  }
}
