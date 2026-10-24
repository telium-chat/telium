package chat.telium.desktop

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidNotificationRecoveryTest {
  @Test
  fun retriesNetworkTimeoutRateLimitAndServerFailures() {
    assertTrue(AndroidNotificationRecovery.shouldRetry(null))
    assertTrue(AndroidNotificationRecovery.shouldRetry(408))
    assertTrue(AndroidNotificationRecovery.shouldRetry(429))
    assertTrue(AndroidNotificationRecovery.shouldRetry(500))
    assertTrue(AndroidNotificationRecovery.shouldRetry(503))
  }

  @Test
  fun doesNotLoopOnPermanentClientFailures() {
    assertFalse(AndroidNotificationRecovery.shouldRetry(400))
    assertFalse(AndroidNotificationRecovery.shouldRetry(401))
    assertFalse(AndroidNotificationRecovery.shouldRetry(403))
    assertFalse(AndroidNotificationRecovery.shouldRetry(404))
  }
}
