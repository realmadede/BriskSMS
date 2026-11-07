package tz.co.brisksms.payment.crypto

import tz.co.brisksms.core.storage.KeystoreSecureStorage

/**
 * Local Evidence Cryptographic Protection
 * Wraps AES-256-GCM encryption so sensitive financial notifications are never stored
 * in plaintext SQLite tables.
 */
class EvidenceEncryptor(private val secureStorage: KeystoreSecureStorage) {

    companion object {
        private const val ENCRYPTED_PREFIX = "bsk_enc_v1:"
    }

    /**
     * Encrypts plaintext raw payload into authenticated ciphertext string
     */
    fun encryptPayload(rawPayload: String): String {
        val encrypted = secureStorage.encrypt(rawPayload)
        return "$ENCRYPTED_PREFIX$encrypted"
    }

    /**
     * Decrypts authenticated ciphertext string back into plaintext
     */
    fun decryptPayload(storedPayload: String): String {
        if (!storedPayload.startsWith(ENCRYPTED_PREFIX)) {
            // Unencrypted legacy fallback
            return storedPayload
        }
        val compound = storedPayload.removePrefix(ENCRYPTED_PREFIX)
        return secureStorage.decrypt(compound) ?: "[CORRUPTED_OR_TAMPERED_PAYLOAD]"
    }

    fun isEncrypted(storedPayload: String): Boolean {
        return storedPayload.startsWith(ENCRYPTED_PREFIX)
    }
}
