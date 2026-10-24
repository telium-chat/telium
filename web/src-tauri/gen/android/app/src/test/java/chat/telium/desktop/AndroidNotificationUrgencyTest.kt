package chat.telium.desktop

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidNotificationUrgencyTest {
  private val now = 1_000_000L

  @Test
  fun staleCallsNeverSurfaceAfterADelayedWake() {
    assertFalse(
      AndroidNotificationUrgency.shouldDisplay(
        "incoming_call",
        now - AndroidNotificationUrgency.CALL_TTL_MS - 1L,
        now,
      ),
    )
    assertFalse(AndroidNotificationUrgency.shouldDisplay("call", 0L, now))
  }

  @Test
  fun freshCallsExpireAtTheEndOfTheSameWindow() {
    val age = 12_345L
    assertTrue(AndroidNotificationUrgency.shouldDisplay("incoming_call", now - age, now))
    assertEquals(
      AndroidNotificationUrgency.CALL_TTL_MS - age,
      AndroidNotificationUrgency.timeoutAfterMs("incoming_call", now - age, now),
    )
  }

  @Test
  fun modestClockSkewDoesNotMakeAFreshCallDisappear() {
    assertTrue(AndroidNotificationUrgency.shouldDisplay("incoming_call", now + 5_000L, now))
    assertEquals(
      AndroidNotificationUrgency.CALL_TTL_MS,
      AndroidNotificationUrgency.timeoutAfterMs("incoming_call", now + 5_000L, now),
    )
  }

  @Test
  fun routineNotificationsDoNotAcquireCallExpiryRules() {
    assertTrue(AndroidNotificationUrgency.shouldDisplay("mention", 0L, now))
    assertNull(AndroidNotificationUrgency.timeoutAfterMs("mention", 0L, now))
  }
}
