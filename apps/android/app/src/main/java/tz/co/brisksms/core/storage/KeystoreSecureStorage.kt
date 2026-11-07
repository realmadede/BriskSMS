package tz.co.brisksms.core.storage

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Keystore-Backed Authenticated AES-256-GCM Secure Storage
 *
 * Implements a modern, non-deprecated alternative to AndroidX EncryptedSharedPreferences:
 * 1. AES-256-GCM master encryption key generated and isolated inside Android Keystore (TEE/StrongBox).
 * 2. 12-byte randomized initialization vectors (IV) per encryption operation.
 * 3. 128-bit authentication tag verification ensuring integrity against local tampering.
 * 4. Graceful recovery on cryptographic failure or device revocation.
 */
class KeystoreSecureStorage(private val context: Context) {

    companion object {
        private const val TAG = "KeystoreSecureStorage"
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val KEY_ALIAS = "brisksms_secure_storage_master_key"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val GCM_IV_LENGTH_BYTES = 12
        private const val GCM_TAG_LENGTH_BITS = 128
        private const val PREFS_FILE = "brisksms_vault_prefs"

        // Keys
        private const val KEY_DEVICE_TOKEN = "device_token"
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_ORGANIZATION_ID = "organization_id"
        private const val KEY_API_BASE_URL = "api_base_url"
        private const val KEY_IS_PAIRED = "is_paired"
        private const val KEY_IS_REVOKED = "is_revoked"
        private const val KEY_GATEWAY_MODE = "gateway_mode"
        private const val KEY_SMSGATE_BASE_URL = "smsgate_base_url"
        private const val KEY_SMSGATE_API_TOKEN = "smsgate_api_token"
        private const val KEY_PAYMENT_INTELLIGENCE_ENABLED = "payment_intelligence_enabled"
        private const val KEY_BULK_MESSAGING_ENABLED = "bulk_messaging_enabled"

        const val DEFAULT_API_BASE_URL = "https://api.brisksms.co.tz"
        const val DEFAULT_SMSGATE_BASE_URL = "https://gateway.brisksms.com/api/v1"
    }

    private val prefs: SharedPreferences = context.getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE)
    private val keyStore: KeyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    init {
        ensureMasterKey()
    }

    private fun ensureMasterKey() {
        if (!keyStore.containsAlias(KEY_ALIAS)) {
            val keyGenerator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
            val builder = KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setUserAuthenticationRequired(false)

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                try {
                    builder.setIsStrongBoxBacked(true)
                    keyGenerator.init(builder.build())
                    keyGenerator.generateKey()
                    return
                } catch (e: Exception) {
                    builder.setIsStrongBoxBacked(false)
                }
            }

            keyGenerator.init(builder.build())
            keyGenerator.generateKey()
        }
    }

    private fun getSecretKey(): SecretKey {
        return (keyStore.getEntry(KEY_ALIAS, null) as KeyStore.SecretKeyEntry).secretKey
    }

    fun encrypt(plaintext: String): String {
        return try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, getSecretKey())
            val iv = cipher.iv
            val ciphertext = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
            val ivB64 = Base64.encodeToString(iv, Base64.NO_WRAP)
            val cipherB64 = Base64.encodeToString(ciphertext, Base64.NO_WRAP)
            "$ivB64:$cipherB64"
        } catch (e: Exception) {
            Log.e(TAG, "Encryption failed: ${e.message}")
            throw SecurityException("SecureStorage encryption failed", e)
        }
    }

    fun decrypt(encryptedCompound: String): String? {
        return try {
            val parts = encryptedCompound.split(":")
            if (parts.size != 2) return null
            val iv = Base64.decode(parts[0], Base64.NO_WRAP)
            val ciphertext = Base64.decode(parts[1], Base64.NO_WRAP)

            val cipher = Cipher.getInstance(TRANSFORMATION)
            val spec = GCMParameterSpec(GCM_TAG_LENGTH_BITS, iv)
            cipher.init(Cipher.DECRYPT_MODE, getSecretKey(), spec)
            val decryptedBytes = cipher.doFinal(ciphertext)
            String(decryptedBytes, Charsets.UTF_8)
        } catch (e: Exception) {
            Log.w(TAG, "Decryption/integrity verification failed: ${e.message}")
            null
        }
    }

    // --- Device Identity & Auth Properties ---

    var deviceToken: String?
        get() = prefs.getString(KEY_DEVICE_TOKEN, null)?.let { decrypt(it) }
        set(value) {
            if (value != null) {
                prefs.edit().putString(KEY_DEVICE_TOKEN, encrypt(value)).apply()
            } else {
                prefs.edit().remove(KEY_DEVICE_TOKEN).apply()
            }
        }

    var deviceId: String?
        get() = prefs.getString(KEY_DEVICE_ID, null)
        set(value) = prefs.edit().putString(KEY_DEVICE_ID, value).apply()

    var organizationId: String?
        get() = prefs.getString(KEY_ORGANIZATION_ID, null)
        set(value) = prefs.edit().putString(KEY_ORGANIZATION_ID, value).apply()

    var apiBaseUrl: String
        get() = prefs.getString(KEY_API_BASE_URL, DEFAULT_API_BASE_URL) ?: DEFAULT_API_BASE_URL
        set(value) = prefs.edit().putString(KEY_API_BASE_URL, value.trimEnd('/')).apply()

    var isPaired: Boolean
        get() = prefs.getBoolean(KEY_IS_PAIRED, false) && deviceToken != null && !isRevoked
        set(value) = prefs.edit().putBoolean(KEY_IS_PAIRED, value).apply()

    var isRevoked: Boolean
        get() = prefs.getBoolean(KEY_IS_REVOKED, false)
        set(value) = prefs.edit().putBoolean(KEY_IS_REVOKED, value).apply()

    // --- Product B: SMSGate Gateway Configuration ---

    var gatewayMode: String
        get() = prefs.getString(KEY_GATEWAY_MODE, "MANAGED_GATEWAY") ?: "MANAGED_GATEWAY"
        set(value) = prefs.edit().putString(KEY_GATEWAY_MODE, value).apply()

    var smsGateBaseUrl: String
        get() = prefs.getString(KEY_SMSGATE_BASE_URL, DEFAULT_SMSGATE_BASE_URL) ?: DEFAULT_SMSGATE_BASE_URL
        set(value) = prefs.edit().putString(KEY_SMSGATE_BASE_URL, value.trimEnd('/')).apply()

    var smsGateApiToken: String?
        get() = prefs.getString(KEY_SMSGATE_API_TOKEN, null)?.let { decrypt(it) }
        set(value) {
            if (value != null) {
                prefs.edit().putString(KEY_SMSGATE_API_TOKEN, encrypt(value)).apply()
            } else {
                prefs.edit().remove(KEY_SMSGATE_API_TOKEN).apply()
            }
        }

    // --- Product Entitlements ---

    var isPaymentIntelligenceEnabled: Boolean
        get() = prefs.getBoolean(KEY_PAYMENT_INTELLIGENCE_ENABLED, true)
        set(value) = prefs.edit().putBoolean(KEY_PAYMENT_INTELLIGENCE_ENABLED, value).apply()

    var isBulkMessagingEnabled: Boolean
        get() = prefs.getBoolean(KEY_BULK_MESSAGING_ENABLED, true)
        set(value) = prefs.edit().putBoolean(KEY_BULK_MESSAGING_ENABLED, value).apply()

    /**
     * Wipes device credentials and resets application state on disconnection or revocation
     */
    fun clear() {
        prefs.edit().clear().apply()
    }
}
