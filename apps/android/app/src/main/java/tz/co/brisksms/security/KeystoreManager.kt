package tz.co.brisksms.security

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.PublicKey
import java.security.Signature

/**
 * Android Keystore Device Identity & Signing Manager
 * Generates and maintains hardware-backed asymmetric key pairs without private key export.
 */
class KeystoreManager {

    companion object {
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val KEY_ALIAS = "brisksms_device_identity_key"
        private const val SIGNATURE_ALGORITHM = "SHA256withECDSA"
    }

    private val keyStore: KeyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply {
        load(null)
    }

    /**
     * Ensures an asymmetric EC P-256 key pair exists inside Android Keystore.
     * Generates a new hardware-backed pair if none exists.
     */
    fun getOrCreateDeviceKeyPair(): Pair<PublicKey, PrivateKey> {
        if (!keyStore.containsAlias(KEY_ALIAS)) {
            generateDeviceKeyPair()
        }

        val entry = keyStore.getEntry(KEY_ALIAS, null) as KeyStore.PrivateKeyEntry
        return Pair(entry.certificate.publicKey, entry.privateKey)
    }

    private fun generateDeviceKeyPair() {
        val kpg = KeyPairGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_EC,
            ANDROID_KEYSTORE
        )

        val builder = KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY
        )
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setUserAuthenticationRequired(false)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            // Attempt StrongBox hardware security module if available
            try {
                builder.setIsStrongBoxBacked(true)
                kpg.initialize(builder.build())
                kpg.generateKeyPair()
                return
            } catch (e: Exception) {
                // Fall back to standard TEE / Keystore if device lacks StrongBox
                builder.setIsStrongBoxBacked(false)
            }
        }

        kpg.initialize(builder.build())
        kpg.generateKeyPair()
    }

    /**
     * Checks whether the device key resides in hardware-backed secure storage (TEE / StrongBox)
     */
    fun isHardwareBacked(): Boolean {
        return try {
            val entry = keyStore.getEntry(KEY_ALIAS, null) as? KeyStore.PrivateKeyEntry ?: return false
            val factory = KeyFactory.getInstance(entry.privateKey.algorithm, ANDROID_KEYSTORE)
            val keyInfo = factory.getKeySpec(entry.privateKey, KeyInfo::class.java)
            keyInfo.isInsideSecureHardware
        } catch (e: Exception) {
            false
        }
    }

    /**
     * Returns the base64-encoded public key for device registration with the backend
     */
    fun getPublicKeyBase64(): String {
        val (publicKey, _) = getOrCreateDeviceKeyPair()
        return Base64.encodeToString(publicKey.encoded, Base64.NO_WRAP)
    }

    /**
     * Signs data using the Keystore private key with SHA256withECDSA
     */
    fun sign(data: ByteArray): String {
        val (_, privateKey) = getOrCreateDeviceKeyPair()
        val signature = Signature.getInstance(SIGNATURE_ALGORITHM).apply {
            initSign(privateKey)
            update(data)
        }
        return Base64.encodeToString(signature.sign(), Base64.NO_WRAP)
    }
}
