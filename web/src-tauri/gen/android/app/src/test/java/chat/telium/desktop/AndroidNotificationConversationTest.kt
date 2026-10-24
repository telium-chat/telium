package chat.telium.desktop

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidNotificationConversationTest {
  @Test
  fun sameGuildChannelUsesTheSameOpaqueGroup() {
    val first = guildGroup("scope-a", "guild.example", "g1", "c1")
    val second = guildGroup("scope-a", "guild.example", "g1", "c1")
    assertEquals(first, second)
    assertTrue(first!!.startsWith("telium_conversation_"))
    assertTrue(!first.contains("guild.example"))
    assertTrue(!first.contains("g1"))
    assertTrue(!first.contains("c1"))
  }

  @Test
  fun differentDestinationsAndAccountsDoNotMerge() {
    assertNotEquals(
      guildGroup("scope-a", "guild.example", "g1", "c1"),
      guildGroup("scope-a", "guild.example", "g1", "c2"),
    )
    assertNotEquals(
      guildGroup("scope-a", "guild.example", "g1", "c1"),
      guildGroup("scope-b", "guild.example", "g1", "c1"),
    )
    assertNotEquals(
      conversationGroup("scope-a", "dm-1"),
      conversationGroup("scope-a", "dm-2"),
    )
  }

  @Test
  fun malformedOrNonMessageDestinationsAreNotGrouped() {
    assertNull(
      AndroidNotificationConversation.groupKey(
        "scope-a", "guild_message", "guild.example", "g1", "", null,
      ),
    )
    assertNull(
      AndroidNotificationConversation.groupKey(
        "scope-a", "account", null, null, null, null,
      ),
    )
  }

  @Test
  fun guildContextIsOnlyVisibleInFullPreviewMode() {
    assertEquals(
      "#general · Telium Testers",
      AndroidNotificationConversation.conversationTitle(
        "full", "guild_message", "Telium Testers", "general",
      ),
    )
    assertNull(
      AndroidNotificationConversation.conversationTitle(
        "sender", "guild_message", "Telium Testers", "general",
      ),
    )
    assertNull(
      AndroidNotificationConversation.conversationTitle(
        "hidden", "guild_message", "Telium Testers", "general",
      ),
    )
    assertNull(
      AndroidNotificationConversation.conversationTitle(
        "full", "conversation", "Telium Testers", "general",
      ),
    )
  }

  private fun guildGroup(scope: String, origin: String, guild: String, channel: String): String? =
    AndroidNotificationConversation.groupKey(
      scope, "guild_message", origin, guild, channel, null,
    )

  private fun conversationGroup(scope: String, conversation: String): String? =
    AndroidNotificationConversation.groupKey(
      scope, "conversation", null, null, null, conversation,
    )
}
