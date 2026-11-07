package tz.co.brisksms.payment.crypto

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class EvidenceEncryptionLogicTest {

    private fun generateTestKey(): SecretKey {
        val keyGen = KeyGenerator.getInstance("AES")
        keyGen.init(256)
        return keyGen.generateKey()
    }

    @Test
    fun aesGcm_encryptAndDecrypt_succeedsWithAuthenticatedTag() {
        val key = generateTestKey()
        val plaintext = "M-PESA Confirmed. Tsh 50,000 received from Juma 0754111222"

        // 1. Encrypt with 12-byte IV and 128-bit authentication tag
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key)
        val iv = cipher.iv
        assertEquals(12, iv.size)

        val ciphertext = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
        val ivB64 = Base64.getEncoder().encodeToString(iv)
        val cipherB64 = Base64.getEncoder().encodeToString(ciphertext)
        val compound = "bsk_enc_v1:$ivB64:$cipherB64"

        assertTrue(compound.startsWith("bsk_enc_v1:"))

        // 2. Decrypt and verify integrity
        val parts = compound.removePrefix("bsk_enc_v1:").split(":")
        assertEquals(2, parts.size)

        val decIv = Base64.getDecoder().decode(parts[0])
        val decCiphertext = Base64.getDecoder().decode(parts[1])

        val decCipher = Cipher.getInstance("AES/GCM/NoPadding")
        val spec = GCMParameterSpec(128, decIv)
        decCipher.init(Cipher.DECRYPT_MODE, key, spec)
        val decryptedBytes = decCipher.doFinal(decCiphertext)
        val decryptedText = String(decryptedBytes, Charsets.UTF_8)

        assertEquals(plaintext, decryptedText)
    }

    @Test(expected = Exception::class)
    fun aesGcm_tamperedCiphertext_failsAuthenticationTagVerification() {
        val key = generateTestKey()
        val plaintext = "Sensitive Transaction Evidence"

        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key)
        val iv = cipher.iv
        val ciphertext = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))

        // Tamper with the ciphertext (flip one byte)
        ciphertext[0] = (ciphertext[0].toInt() xor 0xFF).toByte()

        // Decryption must throw AEADBadTagException / BadPaddingException
        val decCipher = Cipher.getInstance("AES/GCM/NoPadding")
        val spec = GCMParameterSpec(128, iv)
        decCipher.init(Cipher.DECRYPT_MODE, key, spec)
        decCipher.doFinal(ciphertext)
    }

    @Test
    fun aesGcm_uniqueIvPerOperation_producesDifferentCiphertextForSamePlaintext() {
        val key = generateTestKey()
        val plaintext = "Identical Evidence Payload"

        val cipher1 = Cipher.getInstance("AES/GCM/NoPadding")
        cipher1.init(Cipher.ENCRYPT_MODE, key)
        val iv1 = cipher1.iv
        val c1 = cipher1.doFinal(plaintext.toByteArray(Charsets.UTF_8))

        val cipher2 = Cipher.getInstance("AES/GCM/NoPadding")
        cipher2.init(Cipher.ENCRYPT_MODE, key)
        val iv2 = cipher2.iv
        val c2 = cipher2.doFinal(plaintext.toByteArray(Charsets.UTF_8))

        // IVs must be unique
        assertFalse(iv1.contentEquals(iv2))
        // Ciphertexts must be distinct due to unique IVs
        assertFalse(c1.contentEquals(c2))
    }
}
