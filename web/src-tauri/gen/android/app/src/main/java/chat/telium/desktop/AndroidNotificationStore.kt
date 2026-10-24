package chat.telium.desktop

import android.content.Context
import android.net.Uri
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.math.BigInteger
import java.nio.charset.StandardCharsets
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.SecureRandom
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.PKCS8EncodedKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Android-owned persistence for notification encryption and background auth. */
internal object AndroidNotificationStore {
  const val ALGORITHM = "P256-HKDF-SHA256-A256GCM"

  private const val PREFS_NAME = "telium_native_notifications_v1"
  private const val WRAP_KEY_ALIAS = "telium.notifications.wrap.v1"
  private const val ACTIVE_SCOPE = "active_scope"

  data class Scope(
    val homeBase: String,
    val userId: String,
    val deviceId: String,
    val id: String,
  )

  data class Prepared(
    val algorithm: String,
    val publicKey: String,
    val registered: Boolean,
  )

  data class Status(
    val prepared: Boolean,
    val registered: Boolean,
    val previewMode: String,
    val dmNotifications: Boolean,
  )

  data class Registration(
    val scope: Scope,
    val backgroundToken: String,
  )

  fun scope(homeBaseInput: String, userIdInput: String, deviceIdInput: String): Scope {
    val rawHome = homeBaseInput.trim()
    val userId = userIdInput.trim()
    val deviceId = deviceIdInput.trim()
    require(rawHome.length in 1..2048) { "Notification homeserver is missing." }
    require(userId.length in 3..1024) { "Notification user id is missing." }
    require(deviceId.length in 1..1024) { "Notification device id is missing." }

    val uri = Uri.parse(rawHome)
    require(uri.scheme == "https" || uri.scheme == "http") {
      "Notification homeserver must use HTTP(S)."
    }
    require(!uri.host.isNullOrBlank()) { "Notification homeserver is malformed." }
    val homeBase = rawHome.trimEnd('/')
    val material = "$homeBase\u0000$userId\u0000$deviceId".toByteArray(StandardCharsets.UTF_8)
    val id = encode(MessageDigest.getInstance("SHA-256").digest(material))
    return Scope(homeBase, userId, deviceId, id)
  }

  fun prepare(context: Context, scope: Scope): Prepared {
    val publicKey = ensureNotificationKey(context, scope)
    return Prepared(
      algorithm = ALGORITHM,
      publicKey = publicKey,
      registered = prefs(context).contains(registrationKey(scope.id)),
    )
  }

  fun storeRegistration(context: Context, scope: Scope, backgroundToken: String) {
    ensureNotificationKey(context, scope)
    require(backgroundToken.length in 16..4096) { "Notification credential is malformed." }

    val registration = JSONObject()
      .put("home_base", scope.homeBase)
      .put("user_id", scope.userId)
      .put("device_id", scope.deviceId)
      .put("background_token", backgroundToken)
      .toString()
      .toByteArray(StandardCharsets.UTF_8)

    prefs(context).edit()
      .putString(
        registrationKey(scope.id),
        seal(context, registrationAad(scope.id), registration),
      )
      .putString(ACTIVE_SCOPE, scope.id)
      .apply()
  }

  fun status(context: Context, scope: Scope): Status {
    val prefs = prefs(context)
    return Status(
      prepared = prefs.contains(publicKey(scope.id)) && prefs.contains(privateKey(scope.id)),
      registered = prefs.contains(registrationKey(scope.id)),
      previewMode = previewMode(context, scope),
      dmNotifications = dmNotifications(context, scope),
    )
  }

  fun setPreviewMode(context: Context, scope: Scope, mode: String) {
    prefs(context).edit()
      .putString(previewKey(scope.id), AndroidNotificationPreview.normalize(mode))
      .apply()
  }

  fun previewMode(context: Context, scope: Scope): String =
    AndroidNotificationPreview.normalize(prefs(context).getString(previewKey(scope.id), null))

  fun setDmNotifications(context: Context, scope: Scope, enabled: Boolean) {
    prefs(context).edit().putBoolean(dmNotificationsKey(scope.id), enabled).apply()
  }

  fun dmNotifications(context: Context, scope: Scope): Boolean =
    prefs(context).getBoolean(dmNotificationsKey(scope.id), true)

  fun clear(context: Context, scope: Scope) {
    val prefs = prefs(context)
    val edit = prefs.edit()
      .remove(publicKey(scope.id))
      .remove(privateKey(scope.id))
      .remove(registrationKey(scope.id))
      .remove(previewKey(scope.id))
      .remove(dmNotificationsKey(scope.id))
    if (prefs.getString(ACTIVE_SCOPE, null) == scope.id) edit.remove(ACTIVE_SCOPE)
    edit.apply()
  }

  /** Registration for a killed-app inbox fetch. The token never crosses WebView here. */
  fun activeRegistration(context: Context): Registration? {
    val prefs = prefs(context)
    val id = prefs.getString(ACTIVE_SCOPE, null)?.takeIf { it.isNotBlank() } ?: return null
    val sealed = prefs.getString(registrationKey(id), null) ?: return null
    val bytes = try {
      unseal(context, registrationAad(id), sealed)
    } catch (_: Exception) {
      return null
    }
    val value = try {
      JSONObject(String(bytes, StandardCharsets.UTF_8))
    } catch (_: Exception) {
      return null
    }
    val scope = try {
      scope(
        value.optString("home_base"),
        value.optString("user_id"),
        value.optString("device_id"),
      )
    } catch (_: Exception) {
      return null
    }
    if (scope.id != id) return null
    val token = value.optString("background_token")
    if (token.length !in 16..4096) return null
    return Registration(scope, token)
  }

  fun privateKey(context: Context, scope: Scope): PrivateKey {
    val sealed = prefs(context).getString(privateKey(scope.id), null)
      ?: throw IllegalStateException("Notification private key is missing.")
    val encoded = unseal(context, privateAad(scope.id), sealed)
    return KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(encoded))
  }

  /**
   * Returns the public SEC1 P-256 key. Existing storage is verified before it
   * is reused; corrupt or incomplete storage is replaced as one unit and any
   * now-unusable background credential is discarded with it.
   */
  private fun ensureNotificationKey(context: Context, scope: Scope): String {
    val prefs = prefs(context)
    val existingPublic = prefs.getString(publicKey(scope.id), null)
    val existingPrivate = prefs.getString(privateKey(scope.id), null)
    if (existingPublic != null && existingPrivate != null) {
      try {
        val encoded = unseal(context, privateAad(scope.id), existingPrivate)
        KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(encoded))
        val decodedPublic = decode(existingPublic)
        require(decodedPublic.size == 65 && decodedPublic[0] == 0x04.toByte())
        return existingPublic
      } catch (_: Exception) {
        // Regenerate below. The matching server credential is rotated by the
        // WebView immediately after prepare returns the new public key.
      }
    }

    val generator = KeyPairGenerator.getInstance("EC")
    generator.initialize(ECGenParameterSpec("secp256r1"), SecureRandom())
    val pair = generator.generateKeyPair()
    val public = pair.public as ECPublicKey
    val publicEncoded = encodeSec1(public)
    val privateEncoded = pair.private.encoded
      ?: throw IllegalStateException("Android could not export the notification private key.")

    prefs.edit()
      .putString(publicKey(scope.id), encode(publicEncoded))
      .putString(privateKey(scope.id), seal(context, privateAad(scope.id), privateEncoded))
      .remove(registrationKey(scope.id))
      .apply()
    return encode(publicEncoded)
  }

  private fun prefs(context: Context) =
    context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

  private fun publicKey(id: String) = "$id.public"
  private fun privateKey(id: String) = "$id.private"
  private fun registrationKey(id: String) = "$id.registration"
  private fun previewKey(id: String) = "$id.preview"
  private fun dmNotificationsKey(id: String) = "$id.dm_notifications"
  private fun privateAad(id: String) = "telium-notification-private:$id"
  private fun registrationAad(id: String) = "telium-notification-registration:$id"

  private fun wrappingKey(context: Context): SecretKey {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (store.getKey(WRAP_KEY_ALIAS, null) as? SecretKey)?.let { return it }

    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    generator.init(
      KeyGenParameterSpec.Builder(
        WRAP_KEY_ALIAS,
        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
      )
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .setRandomizedEncryptionRequired(true)
        .build(),
    )
    return generator.generateKey()
  }

  private fun seal(context: Context, aad: String, plaintext: ByteArray): String {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, wrappingKey(context))
    cipher.updateAAD(aad.toByteArray(StandardCharsets.UTF_8))
    val ciphertext = cipher.doFinal(plaintext)
    return "v1.${encode(cipher.iv)}.${encode(ciphertext)}"
  }

  private fun unseal(context: Context, aad: String, sealed: String): ByteArray {
    val parts = sealed.split('.')
    require(parts.size == 3 && parts[0] == "v1") { "Stored notification secret is malformed." }
    val iv = decode(parts[1])
    require(iv.size == 12) { "Stored notification secret has an invalid nonce." }
    val ciphertext = decode(parts[2])
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, wrappingKey(context), GCMParameterSpec(128, iv))
    cipher.updateAAD(aad.toByteArray(StandardCharsets.UTF_8))
    return cipher.doFinal(ciphertext)
  }

  private fun encodeSec1(key: ECPublicKey): ByteArray {
    val x = fixed32(key.w.affineX)
    val y = fixed32(key.w.affineY)
    return byteArrayOf(0x04) + x + y
  }

  private fun fixed32(value: BigInteger): ByteArray {
    val raw = value.toByteArray()
    val unsigned = if (raw.size > 1 && raw[0] == 0.toByte()) raw.copyOfRange(1, raw.size) else raw
    require(unsigned.size <= 32) { "Invalid P-256 coordinate." }
    return ByteArray(32).also { target ->
      System.arraycopy(unsigned, 0, target, target.size - unsigned.size, unsigned.size)
    }
  }

  internal fun encode(bytes: ByteArray): String = Base64.encodeToString(
    bytes,
    Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING,
  )

  internal fun decode(value: String): ByteArray = Base64.decode(
    value,
    Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING,
  )
}
