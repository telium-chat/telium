package chat.telium.desktop

import org.junit.Assert.assertEquals
import org.junit.Test

class AndroidNotificationChannelsTest {
  @Test
  fun mentionsAndRepliesUseTheirOwnUrgentChannel() {
    assertEquals(
      AndroidNotificationChannels.Bucket.MENTION,
      AndroidNotificationChannels.forKind("mention"),
    )
    assertEquals(
      AndroidNotificationChannels.Bucket.MENTION,
      AndroidNotificationChannels.forKind("reply"),
    )
  }

  @Test
  fun callsAndAccountEventsStayOutOfRoutineMessages() {
    assertEquals(
      AndroidNotificationChannels.Bucket.CALL,
      AndroidNotificationChannels.forKind("incoming_call"),
    )
    assertEquals(
      AndroidNotificationChannels.Bucket.ACCOUNT,
      AndroidNotificationChannels.forKind("security"),
    )
    assertEquals(
      AndroidNotificationChannels.Bucket.ACCOUNT,
      AndroidNotificationChannels.forKind("migration"),
    )
  }

  @Test
  fun encryptedDirectMessagesAreRoutineRatherThanMentions() {
    // Not merely "not urgent": the account home cannot read the MLS plaintext,
    // so it cannot know whether this DM mentions anybody. Routine is the only
    // classification it is entitled to make.
    assertEquals(
      AndroidNotificationChannels.Bucket.MESSAGE,
      AndroidNotificationChannels.forKind("encrypted_message"),
    )
  }

  @Test
  fun ordinaryAndUnknownKindsDefaultToTheQuietMessageChannel() {
    assertEquals(
      AndroidNotificationChannels.Bucket.MESSAGE,
      AndroidNotificationChannels.forKind("dm_hint"),
    )

    assertEquals(
      AndroidNotificationChannels.Bucket.MESSAGE,
      AndroidNotificationChannels.forKind("future_kind"),
    )
  }

  @Test
  fun everyBucketHasAStableDistinctChannelId() {
    val ids = AndroidNotificationChannels.Bucket.values().map { it.id }
    assertEquals(ids.size, ids.toSet().size)
    assertEquals("telium_messages", AndroidNotificationChannels.Bucket.MESSAGE.id)
    assertEquals("telium_mentions", AndroidNotificationChannels.Bucket.MENTION.id)
    assertEquals("telium_calls", AndroidNotificationChannels.Bucket.CALL.id)
    assertEquals(
      "telium_account_security",
      AndroidNotificationChannels.Bucket.ACCOUNT.id,
    )
  }

  @Test
  fun onlyMessageLikeChannelsContributeToTheUnreadBadge() {
    assertEquals(true, AndroidNotificationChannels.Bucket.MESSAGE.contributesToUnreadBadge)
    assertEquals(true, AndroidNotificationChannels.Bucket.MENTION.contributesToUnreadBadge)
    assertEquals(false, AndroidNotificationChannels.Bucket.CALL.contributesToUnreadBadge)
    assertEquals(false, AndroidNotificationChannels.Bucket.ACCOUNT.contributesToUnreadBadge)
  }
}
