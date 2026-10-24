package chat.telium.desktop

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidNotificationDestinationTest {
  @Test
  fun conversationNeedsOnlyABoundedConversationId() {
    assertTrue(
      AndroidNotificationDestination.isValid(
        type = "conversation",
        conversationId = "dm-1",
      ),
    )
    assertFalse(AndroidNotificationDestination.isValid(type = "conversation", conversationId = ""))
    assertFalse(
      AndroidNotificationDestination.isValid(
        type = "conversation",
        conversationId = "x".repeat(1025),
      ),
    )
  }

  @Test
  fun guildMessageStillRequiresEveryRoutingField() {
    assertTrue(
      AndroidNotificationDestination.isValid(
        type = "guild_message",
        guildOrigin = "guild.example",
        guildId = "guild-1",
        channelId = "channel-1",
        messageId = "message-1",
      ),
    )
    assertFalse(
      AndroidNotificationDestination.isValid(
        type = "guild_message",
        guildOrigin = "guild.example",
        guildId = "guild-1",
        channelId = "channel-1",
      ),
    )
  }

  @Test
  fun unknownDestinationTypesAreRejected() {
    assertFalse(AndroidNotificationDestination.isValid(type = "future", conversationId = "dm-1"))
  }

  @Test
  fun answerActionIsOnlyValidForConversations() {
    assertTrue(
      AndroidNotificationDestination.isValidAction(
        AndroidNotificationDestination.ACTION_ANSWER_CALL,
        "conversation",
      ),
    )
    assertFalse(
      AndroidNotificationDestination.isValidAction(
        AndroidNotificationDestination.ACTION_ANSWER_CALL,
        "guild_message",
      ),
    )
    assertFalse(AndroidNotificationDestination.isValidAction("future", "conversation"))
  }
}
