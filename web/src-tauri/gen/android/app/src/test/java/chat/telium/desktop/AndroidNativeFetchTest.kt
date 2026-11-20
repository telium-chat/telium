package chat.telium.desktop

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class AndroidNativeFetchTest {
  @Test
  fun acceptsOnlyPlainHttpsAddresses() {
    assertEquals("example.org", AndroidNativeFetch.checkedUrl("https://example.org/telium.txt").host)
    for (bad in listOf(
      "http://example.org/telium.txt",
      "file:///etc/passwd",
      "https://user:pw@example.org/",
      "https:///nohost",
      "not a url",
    )) {
      assertThrows(bad, AndroidNativeFetch.Refused::class.java) { AndroidNativeFetch.checkedUrl(bad) }
    }
  }

  @Test
  fun forwardsOnlyAShortPrintableAcceptHeader() {
    assertEquals("text/plain", AndroidNativeFetch.safeAccept("text/plain"))
    assertEquals("*/*", AndroidNativeFetch.safeAccept("text/plain\r\nX-Evil: 1"))
    assertEquals("*/*", AndroidNativeFetch.safeAccept("a".repeat(200)))
    assertEquals("*/*", AndroidNativeFetch.safeAccept(null))
  }

  @Test
  fun hexEncodesDigests() {
    assertEquals("00ff10", AndroidSelfUpdate.hex(byteArrayOf(0, -1, 16)))
  }
}
