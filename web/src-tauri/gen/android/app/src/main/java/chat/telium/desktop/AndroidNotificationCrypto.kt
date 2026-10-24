package chat.telium.desktop

import org.json.JSONObject
import java.math.BigInteger
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets
import java.security.PrivateKey
import java.security.interfaces.ECPrivateKey
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import java.security.KeyFactory
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** Implements the server's P256-HKDF-SHA256-A256GCM notification envelope. */
internal object AndroidNotificationCrypto {
  private val AAD_PREFIX = "telium-notification-v1".toByteArray(StandardCharsets.UTF_8)
  private val HKDF_INFO_PREFIX = "Telium notification v1\u0000".toByteArray(StandardCharsets.UTF_8)

  fun decrypt(
    privateKey: PrivateKey,
    userId: String,
    deviceId: String,
    origin: String,
    sourceId: String,
    guildId: String?,
    kind: String,
    envelope: JSONObject,
  ): JSONObject {
    require(envelope.optInt("v") == 1) { "Unsupported notification envelope version." }
    require(envelope.optString("alg") == AndroidNotificationStore.ALGORITHM) {
      "Unsupported notification encryption algorithm."
    }

    val ephemeralBytes = AndroidNotificationStore.decode(envelope.optString("ephemeral"))
    val salt = AndroidNotificationStore.decode(envelope.optString("salt"))
    val nonce = AndroidNotificationStore.decode(envelope.optString("nonce"))
    val ciphertext = AndroidNotificationStore.decode(envelope.optString("ciphertext"))
    require(ephemeralBytes.size == 65 && ephemeralBytes[0] == 0x04.toByte()) {
      "Notification envelope has an invalid P-256 key."
    }
    require(salt.size == 16) { "Notification envelope has an invalid salt." }
    require(nonce.size == 12) { "Notification envelope has an invalid nonce." }
    require(ciphertext.isNotEmpty() && ciphertext.size <= 16 * 1024) {
      "Notification envelope ciphertext is invalid."
    }

    val ecPrivate = privateKey as? ECPrivateKey
      ?: throw IllegalArgumentException("Notification private key is not P-256.")
    val x = BigInteger(1, ephemeralBytes.copyOfRange(1, 33))
    val y = BigInteger(1, ephemeralBytes.copyOfRange(33, 65))
    val publicKey = KeyFactory.getInstance("EC").generatePublic(
      ECPublicKeySpec(ECPoint(x, y), ecPrivate.params),
    )

    val agreement = KeyAgreement.getInstance("ECDH")
    agreement.init(privateKey)
    agreement.doPhase(publicKey, true)
    val shared = agreement.generateSecret()

    val aad = associatedData(userId, deviceId, origin, sourceId, guildId, kind)
    val info = HKDF_INFO_PREFIX + aad
    val key = hkdfSha256(shared, salt, info, 32)

    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(
      Cipher.DECRYPT_MODE,
      SecretKeySpec(key, "AES"),
      GCMParameterSpec(128, nonce),
    )
    cipher.updateAAD(aad)
    val plaintext = cipher.doFinal(ciphertext)
    require(plaintext.size <= 8 * 1024) { "Notification descriptor is too large." }

    val descriptor = JSONObject(String(plaintext, StandardCharsets.UTF_8))
    require(descriptor.optInt("v") == 1) { "Unsupported notification descriptor version." }
    require(descriptor.optString("kind") == kind) { "Notification descriptor kind mismatch." }

    // The guild server authors the plaintext preview, but it must not be able
    // to smuggle a navigation target outside the item authenticated by the AAD.
    // For guild-message notifications, origin/guild/message are therefore
    // exact matches; only the channel is descriptor data, and it still has
    // strict shape bounds. Replies use the same destination contract as
    // mentions, so adding a new trigger kind must not weaken this check.
    if (kind == "mention" || kind == "reply") {
      val destination = descriptor.optJSONObject("destination")
        ?: throw IllegalArgumentException("Notification destination is missing.")
      require(destination.optString("type") == "guild_message") {
        "Notification destination type mismatch."
      }
      require(destination.optString("guild_origin") == origin) {
        "Notification destination origin mismatch."
      }
      require(guildId != null && destination.optString("guild_id") == guildId) {
        "Notification destination guild mismatch."
      }
      require(destination.optString("message_id") == sourceId) {
        "Notification destination message mismatch."
      }
      val channelId = destination.optString("channel_id")
      require(channelId.isNotBlank() && channelId.length <= 1024) {
        "Notification destination channel is invalid."
      }
    }

    // An encrypted DM wake is held to the same rule -- a descriptor whose
    // destination does not match its kind is refused -- but a different amount
    // of it can be proved, and it is worth saying which. There is no guild id
    // in the AAD for a conversation and the conversation id is not in it
    // either, deliberately: binding it would mean writing the conversation in
    // the clear beside the ciphertext for the account home to keep, which is
    // the one fact this whole path is arranged to withhold from it. So the
    // check here is kind-to-shape rather than identity: an `encrypted_message`
    // may only ever carry a `conversation` destination, and a `mention` may
    // only ever carry a `guild_message` one, so neither kind can borrow the
    // other's routing. What remains unproven is *which* conversation, and the
    // envelope was still sealed to this device by this account's own home, so
    // the worst a wrong id can do is open one of this account's conversations
    // instead of another. That is a misrouted tap, not a disclosure.
    if (kind == "encrypted_message") {
      val destination = descriptor.optJSONObject("destination")
        ?: throw IllegalArgumentException("Notification destination is missing.")
      require(destination.optString("type") == "conversation") {
        "Notification destination type mismatch."
      }
      val conversationId = destination.optString("conversation_id")
      require(conversationId.isNotBlank() && conversationId.length <= 1024) {
        "Notification destination conversation is invalid."
      }
    }
    return descriptor
  }

  private fun associatedData(
    userId: String,
    deviceId: String,
    origin: String,
    sourceId: String,
    guildId: String?,
    kind: String,
  ): ByteArray {
    val parts = listOf(userId, deviceId, origin, sourceId, guildId ?: "", kind)
    val size = AAD_PREFIX.size + parts.sumOf { 4 + it.toByteArray(StandardCharsets.UTF_8).size }
    val buffer = ByteBuffer.allocate(size)
    buffer.put(AAD_PREFIX)
    for (part in parts) {
      val bytes = part.toByteArray(StandardCharsets.UTF_8)
      buffer.putInt(bytes.size)
      buffer.put(bytes)
    }
    return buffer.array()
  }

  /** RFC 5869 extract + expand. Telium currently derives one 32-byte block. */
  private fun hkdfSha256(
    inputKeyMaterial: ByteArray,
    salt: ByteArray,
    info: ByteArray,
    length: Int,
  ): ByteArray {
    require(length in 1..(255 * 32)) { "Invalid HKDF output length." }
    val hmac = Mac.getInstance("HmacSHA256")
    hmac.init(SecretKeySpec(salt, "HmacSHA256"))
    val prk = hmac.doFinal(inputKeyMaterial)

    val output = ByteArray(length)
    var previous = ByteArray(0)
    var written = 0
    var counter = 1
    while (written < length) {
      hmac.init(SecretKeySpec(prk, "HmacSHA256"))
      hmac.update(previous)
      hmac.update(info)
      hmac.update(counter.toByte())
      previous = hmac.doFinal()
      val take = minOf(previous.size, length - written)
      System.arraycopy(previous, 0, output, written, take)
      written += take
      counter += 1
    }
    return output
  }
}
