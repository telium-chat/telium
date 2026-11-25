package chat.telium.desktop

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AndroidNotificationIndexTest {
  @Test
  fun aMentionAndItsChannelDismissalShareOnePlace() {
    val mention = AndroidNotificationIndex.placeFor(
      type = "guild_message",
      guildOrigin = "guild.example",
      guildId = "g1",
      channelId = "c1",
    )
    val dismissal = AndroidNotificationIndex.placeFor(
      type = "guild_channel",
      guildOrigin = "guild.example",
      guildId = "g1",
      channelId = "c1",
    )
    assertEquals("channel:guild.example:g1:c1", mention)
    assertEquals(mention, dismissal)
  }

  @Test
  fun conversationsAreKeyedByIdAndBadInputHasNoPlace() {
    assertEquals(
      "conversation:dm-1",
      AndroidNotificationIndex.placeFor(type = "conversation", conversationId = "dm-1"),
    )
    assertNull(AndroidNotificationIndex.placeFor(type = "conversation", conversationId = ""))
    assertNull(AndroidNotificationIndex.placeFor(type = "conversation", conversationId = "x".repeat(1025)))
    assertNull(AndroidNotificationIndex.placeFor(type = "guild_message", guildOrigin = "o", guildId = "g"))
    assertNull(AndroidNotificationIndex.placeFor(type = "incoming_call", conversationId = "dm-1"))
  }
}
