package tz.co.brisksms.security

import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.security.MessageDigest
import java.time.Instant
import java.util.Base64

data class PairingChallengePayload(
    val protocolVersion: String,
    val challengeId: String,
    val enrollmentId: String,
    val organizationId: String,
    val challenge: String,
    val publicKeyFingerprint: String,
    val keyAlgorithm: String,
    val signatureAlgorithm: String,
    val issuedAt: String,
    val expiresAt: String
)

data class PairingCompletionPayload(
    val deviceId: String,
    val organizationId: String,
    val deviceToken: String,
    val publicKeyFingerprint: String,
    val keyAlgorithm: String,
    val syncIntervalSeconds: Int,
    /** For display only. Blank when the server did not send them. */
    val organizationName: String = "",
    val accountType: String = ""
)

class PairingApiException(
    val statusCode: Int,
    val errorCode: String,
    override val message: String
) : Exception(message)

/**
 * Pure JVM protocol implementation for BriskSMS Android device pairing Proof-of-Possession.
 * Implements domain-separated length-prefixed binary transcripts and strict challenge validation
 * matching the backend verification contract byte-for-byte.
 */
object DevicePairingProtocol {

    const val PROTOCOL_VERSION = "BRISKSMS-DEVICE-PAIRING-POP-V1"
    const val KEY_ALGORITHM = "EC_P256"
    const val SIGNATURE_ALGORITHM = "SHA256_ECDSA"
    const val ERROR_CHALLENGE_EXPIRED = "CHALLENGE_EXPIRED"

    private const val PEM_HEADER = "-----BEGIN PUBLIC KEY-----"
    private const val PEM_FOOTER = "-----END PUBLIC KEY-----"

    fun sha256Hex(bytes: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
        val hex = StringBuilder(digest.size * 2)
        for (b in digest) {
            hex.append(String.format("%02x", b))
        }
        return hex.toString()
    }

    fun computePublicKeyFingerprint(spkiDer: ByteArray): String {
        return sha256Hex(spkiDer)
    }

    fun encodePublicKeyPem(spkiDer: ByteArray): String {
        val base64 = Base64.getEncoder().encodeToString(spkiDer)
        val lines = base64.chunked(64).joinToString("\n")
        return "$PEM_HEADER\n$lines\n$PEM_FOOTER"
    }

    /**
     * Builds the canonical, unambiguous, length-prefixed binary signing transcript:
     * for each ordered field: uint32_be(utf8ByteLength) || utf8Bytes.
     */
    fun buildCanonicalSigningPayload(
        challengeId: String,
        enrollmentId: String,
        organizationId: String,
        enrollmentToken: String,
        publicKeyFingerprint: String,
        keyAlgorithm: String,
        signatureAlgorithm: String,
        challengeNonce: String,
        expiresAt: String
    ): ByteArray {
        val pairingTokenHash = sha256Hex(enrollmentToken.toByteArray(Charsets.UTF_8))
        val fields = listOf(
            PROTOCOL_VERSION,
            challengeId,
            enrollmentId,
            organizationId,
            pairingTokenHash,
            publicKeyFingerprint,
            keyAlgorithm,
            signatureAlgorithm,
            challengeNonce,
            expiresAt
        )

        val baos = ByteArrayOutputStream()
        val dos = DataOutputStream(baos)
        for (field in fields) {
            val utf8 = field.toByteArray(Charsets.UTF_8)
            dos.writeInt(utf8.size)
            dos.write(utf8)
        }
        dos.flush()
        return baos.toByteArray()
    }

    fun validateChallengeResponse(
        expectedOrgId: String?,
        localPublicKeyFingerprint: String,
        challenge: PairingChallengePayload,
        nowMillis: Long = System.currentTimeMillis()
    ): Result<Unit> {
        if (challenge.protocolVersion != PROTOCOL_VERSION) {
            return Result.failure(
                IllegalStateException("Unsupported pairing PoP protocol version: ${challenge.protocolVersion}")
            )
        }
        if (challenge.keyAlgorithm != KEY_ALGORITHM) {
            return Result.failure(
                IllegalStateException("Unsupported pairing key algorithm: ${challenge.keyAlgorithm}")
            )
        }
        if (challenge.signatureAlgorithm != SIGNATURE_ALGORITHM) {
            return Result.failure(
                IllegalStateException("Unsupported pairing signature algorithm: ${challenge.signatureAlgorithm}")
            )
        }
        if (challenge.challengeId.isBlank() ||
            challenge.enrollmentId.isBlank() ||
            challenge.organizationId.isBlank() ||
            challenge.challenge.isBlank()
        ) {
            return Result.failure(IllegalStateException("Incomplete challenge metadata from server"))
        }
        if (!expectedOrgId.isNullOrBlank() && challenge.organizationId != expectedOrgId) {
            return Result.failure(
                IllegalStateException("Organization mismatch in server pairing challenge")
            )
        }
        if (challenge.publicKeyFingerprint != localPublicKeyFingerprint) {
            return Result.failure(
                IllegalStateException("Server challenge public key fingerprint mismatch")
            )
        }
        val expiresMillis = try {
            Instant.parse(challenge.expiresAt).toEpochMilli()
        } catch (e: Exception) {
            return Result.failure(IllegalStateException("Invalid challenge expiration timestamp", e))
        }
        if (expiresMillis <= nowMillis) {
            return Result.failure(
                PairingApiException(401, ERROR_CHALLENGE_EXPIRED, "Server pairing challenge is already expired")
            )
        }
        return Result.success(Unit)
    }
}
