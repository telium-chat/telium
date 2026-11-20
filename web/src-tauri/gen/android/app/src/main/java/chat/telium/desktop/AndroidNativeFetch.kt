package chat.telium.desktop

import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL

/// A bounded, public-document GET for the WebView, which cannot read another
/// origin's `/telium.txt`, the signed recommendation feed or a release manifest
/// because those sites do not send CORS headers.
///
/// Deliberately not a general fetch primitive. HTTPS only, GET only, no
/// credentials or cookies, every redirect hop re-checked as HTTPS, and the body
/// is capped. The caller cannot choose request headers beyond `Accept`.
object AndroidNativeFetch {
  const val MAX_BYTES_CEILING = 1024 * 1024
  private const val MAX_REDIRECTS = 5
  private const val TIMEOUT_MS = 12_000

  data class Result(
    val status: Int,
    val url: String,
    val contentType: String?,
    val body: ByteArray,
  )

  class Refused(message: String) : Exception(message)

  /// `https://host[:port]/path`, no userinfo. Anything else is refused outright.
  fun checkedUrl(raw: String): URL {
    val uri = try { URI(raw) } catch (_: Exception) { throw Refused("That address is not valid.") }
    if (uri.scheme?.lowercase() != "https") throw Refused("Only HTTPS addresses can be read.")
    if (uri.host.isNullOrBlank()) throw Refused("That address has no host.")
    if (uri.userInfo != null) throw Refused("Addresses with credentials are refused.")
    return uri.toURL()
  }

  /// A header value we are willing to forward: short, printable, one line.
  fun safeAccept(raw: String?): String {
    val value = raw?.trim().orEmpty()
    if (value.isEmpty() || value.length > 100) return "*/*"
    return if (value.all { it.code in 0x20..0x7e }) value else "*/*"
  }

  fun get(rawUrl: String, accept: String?, follow: Boolean, maxBytes: Int): Result {
    val limit = maxBytes.coerceIn(1, MAX_BYTES_CEILING)
    var url = checkedUrl(rawUrl)
    var hops = 0
    while (true) {
      val conn = url.openConnection() as HttpURLConnection
      try {
        conn.requestMethod = "GET"
        conn.instanceFollowRedirects = false
        conn.useCaches = false
        conn.connectTimeout = TIMEOUT_MS
        conn.readTimeout = TIMEOUT_MS
        conn.setRequestProperty("Accept", safeAccept(accept))
        conn.setRequestProperty("User-Agent", "Telium-Android")
        val status = conn.responseCode
        if (follow && status in 300..399 && status != 304) {
          val location = conn.getHeaderField("Location") ?: throw Refused("A redirect had no destination.")
          if (++hops > MAX_REDIRECTS) throw Refused("Too many redirects.")
          // Resolved against the current URL, then held to the same rules.
          url = checkedUrl(url.toURI().resolve(location).toString())
          continue
        }
        val body = if (status in 200..299) readCapped(conn, limit) else ByteArray(0)
        return Result(status, url.toString(), conn.contentType, body)
      } finally {
        conn.disconnect()
      }
    }
  }

  private fun readCapped(conn: HttpURLConnection, limit: Int): ByteArray {
    val declared = conn.contentLengthLong
    if (declared > limit) throw Refused("That document is larger than Telium will read.")
    val out = ByteArrayOutputStream()
    val buffer = ByteArray(8192)
    conn.inputStream.use { input ->
      while (true) {
        val n = input.read(buffer)
        if (n < 0) break
        if (out.size() + n > limit) throw Refused("That document is larger than Telium will read.")
        out.write(buffer, 0, n)
      }
    }
    return out.toByteArray()
  }
}
