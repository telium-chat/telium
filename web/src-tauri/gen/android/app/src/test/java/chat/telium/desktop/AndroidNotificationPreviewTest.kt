package chat.telium.desktop

import org.junit.Assert.assertEquals
import org.junit.Test

class AndroidNotificationPreviewTest {
  @Test
  fun fullModeShowsTheDecryptedPreview() {
    assertEquals(
      AndroidNotificationPreview.Visible("Alice", "secret message"),
      AndroidNotificationPreview.render("full", "Alice", "secret message", "New mention"),
    )
  }

  @Test
  fun senderModeKeepsTheSenderButNotTheMessage() {
    assertEquals(
      AndroidNotificationPreview.Visible("Alice", "New mention"),
      AndroidNotificationPreview.render("sender", "Alice", "secret message", "New mention"),
    )
  }

  @Test
  fun hiddenModeKeepsNeitherSenderNorMessage() {
    assertEquals(
      AndroidNotificationPreview.Visible("Telium", "New mention"),
      AndroidNotificationPreview.render("hidden", "Alice", "secret message", "New mention"),
    )
  }

  @Test
  fun encryptedDirectMessagesSayOnlyThatSomethingArrived() {
    // The string is a constant on both sides of the wire: the server asserts it
    // in conversation_descriptor_tests, and genericNotificationBody in
    // web/src/lib/notification-preview.js returns the same words.
    //
    // Both direct-message kinds answer with it. They come from two different
    // mechanisms -- `encrypted_message` from the account home, `dm_hint` from
    // the sealed per-device path -- and a person should not be able to tell
    // which one woke their phone, so the wording is asserted for both rather
    // than for whichever one the reader happens to be thinking about.
    assertEquals("Encrypted message", AndroidNotificationPreview.genericBody("encrypted_message"))
    assertEquals("Encrypted message", AndroidNotificationPreview.genericBody("dm_hint"))
  }

  @Test
  fun dmHintsStayGenericEvenWhenPreviewModeAllowsContent() {
    // Full preview mode is the case worth pinning. It is the one mode that
    // would show a real message body if one were ever handed to it, and for a
    // dm_hint there is none to hand over: the sealed hint says a frame arrived
    // and nothing about what it said. The generic body therefore has to
    // survive the mode that would have replaced it.
    assertEquals(
      AndroidNotificationPreview.Visible("alice", "Encrypted message"),
      AndroidNotificationPreview.render(
        "full",
        "alice",
        "Encrypted message",
        AndroidNotificationPreview.genericBody("dm_hint"),
      ),
    )
  }

  @Test
  fun hidingAnEncryptedDirectMessageLeavesNothingButTelium() {
    assertEquals(
      AndroidNotificationPreview.Visible("Telium", "Encrypted message"),
      AndroidNotificationPreview.render(
        "hidden",
        "Alice",
        "Encrypted message",
        AndroidNotificationPreview.genericBody("encrypted_message"),
      ),
    )
    assertEquals(
      AndroidNotificationPreview.Visible("Telium", "Encrypted message"),
      AndroidNotificationPreview.render(
        "hidden",
        "alice",
        "Encrypted message",
        AndroidNotificationPreview.genericBody("dm_hint"),
      ),
    )
  }

  @Test
  fun unknownModesStayBackwardsCompatible() {
    assertEquals("full", AndroidNotificationPreview.normalize("future"))
  }
}
