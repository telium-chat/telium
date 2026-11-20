package chat.telium.desktop

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import java.io.File
import java.net.HttpURLConnection
import java.security.MessageDigest

/// Replaces the installed APK with one the signed release manifest named.
///
/// JavaScript has already verified the manifest signature; this side does not
/// trust it further than it must. It enforces HTTPS, the declared size and
/// SHA-256, that the file is an APK for this same package that is newer than the
/// installed one, and that it carries the installed app's signing certificate --
/// and then hands the file to Android's installer, which still asks the reader to
/// confirm. Nothing installs silently, and nothing here can.
class AndroidSelfUpdate(private val activity: Activity) {
  class Failed(message: String) : Exception(message)

  private val dir get() = File(activity.cacheDir, "updates")

  fun canInstall(): Boolean =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.O || activity.packageManager.canRequestPackageInstalls()

  /// Runs on a worker thread. `progress(received, total)` is throttled by the caller.
  /// Returns "installer" once Android's installer has been shown, or
  /// "needs-permission" after sending the reader to the per-app setting.
  fun install(url: String, sha256: String, size: Long, progress: (Long, Long) -> Unit, verifying: () -> Unit): String {
    if (!Regex("^[0-9a-f]{64}$").matches(sha256.lowercase())) throw Failed("The update has no valid checksum.")
    if (size <= 0 || size > MAX_APK_BYTES) throw Failed("The update has an implausible size.")
    AndroidNativeFetch.checkedUrl(url)

    dir.mkdirs()
    val target = File(dir, "telium-update.apk")
    val digest = sha256.lowercase()
    if (!(target.isFile && target.length() == size && hashOf(target) == digest)) {
      download(url, size, target, progress)
      verifying()
      if (target.length() != size || hashOf(target) != digest) {
        target.delete()
        throw Failed("The downloaded update did not match its checksum.")
      }
    }
    checkIsOurUpdate(target)

    if (!canInstall()) {
      activity.runOnUiThread {
        val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}"))
        try { activity.startActivity(intent) } catch (_: Exception) {}
      }
      return "needs-permission"
    }

    val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", target)
    activity.runOnUiThread {
      val intent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, "application/vnd.android.package-archive")
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      activity.startActivity(intent)
    }
    return "installer"
  }

  private fun download(url: String, size: Long, target: File, progress: (Long, Long) -> Unit) {
    val tmp = File(dir, "telium-update.apk.part")
    var current = AndroidNativeFetch.checkedUrl(url)
    var hops = 0
    while (true) {
      val conn = current.openConnection() as HttpURLConnection
      try {
        conn.instanceFollowRedirects = false
        conn.useCaches = false
        conn.connectTimeout = 15_000
        conn.readTimeout = 30_000
        conn.setRequestProperty("User-Agent", "Telium-Android")
        val status = conn.responseCode
        if (status in 300..399) {
          val location = conn.getHeaderField("Location") ?: throw Failed("The update download was redirected nowhere.")
          if (++hops > 5) throw Failed("The update download was redirected too many times.")
          current = AndroidNativeFetch.checkedUrl(current.toURI().resolve(location).toString())
          continue
        }
        if (status != 200) throw Failed("The update server answered $status.")
        var received = 0L
        conn.inputStream.use { input ->
          tmp.outputStream().use { out ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
              val n = input.read(buffer)
              if (n < 0) break
              received += n
              // Never more than the manifest promised, however long the server keeps talking.
              if (received > size) throw Failed("The update was larger than announced.")
              out.write(buffer, 0, n)
              progress(received, size)
            }
          }
        }
        if (target.exists()) target.delete()
        if (!tmp.renameTo(target)) throw Failed("The update could not be saved.")
        return
      } catch (e: Exception) {
        tmp.delete()
        throw e
      } finally {
        conn.disconnect()
      }
    }
  }

  @Suppress("DEPRECATION")
  private fun signers(info: PackageInfo): Set<String> {
    val raw = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      info.signingInfo?.apkContentsSigners
    } else {
      info.signatures
    } ?: return emptySet()
    return raw.map { hex(MessageDigest.getInstance("SHA-256").digest(it.toByteArray())) }.toSet()
  }

  @Suppress("DEPRECATION")
  private fun checkIsOurUpdate(apk: File) {
    val pm = activity.packageManager
    val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      PackageManager.GET_SIGNING_CERTIFICATES
    } else {
      PackageManager.GET_SIGNATURES
    }
    val candidate = pm.getPackageArchiveInfo(apk.absolutePath, flags)
      ?: throw Failed("The downloaded file is not an installable app.")
    if (candidate.packageName != activity.packageName) throw Failed("The downloaded app is not Telium.")
    val installed = pm.getPackageInfo(activity.packageName, flags)
    if (versionOf(candidate) <= versionOf(installed)) throw Failed("The downloaded update is not newer than this one.")
    val have = signers(installed)
    val want = signers(candidate)
    // Android refuses a different key at install time as well; saying so here
    // names the cause instead of leaving a generic "app not installed".
    if (have.isEmpty() || want.isEmpty() || have != want) {
      throw Failed("The update is signed with a different key than this install, so Android would refuse it.")
    }
  }

  @Suppress("DEPRECATION")
  private fun versionOf(info: PackageInfo): Long =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode else info.versionCode.toLong()

  companion object {
    const val MAX_APK_BYTES = 300L * 1024 * 1024

    fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }

    fun hashOf(file: File): String {
      val digest = MessageDigest.getInstance("SHA-256")
      file.inputStream().use { input ->
        val buffer = ByteArray(64 * 1024)
        while (true) {
          val n = input.read(buffer)
          if (n < 0) break
          digest.update(buffer, 0, n)
        }
      }
      return hex(digest.digest())
    }
  }
}
