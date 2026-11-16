package tz.co.brisksms.security

interface DeviceKeyProvider {
    fun getPublicKeyPem(): String
    fun getPublicKeyFingerprintHex(): String
    fun sign(data: ByteArray): String
}

data class PairSubmissionPayload(
    val enrollmentToken: String,
    val challengeId: String,
    val enrollmentId: String,
    val organizationId: String,
    val keyAlgorithm: String,
    val signatureAlgorithm: String,
    val challengeSignature: String,
    val publicKeyPem: String,
    val label: String,
    val deviceModel: String,
    val manufacturer: String,
    val androidVersion: String,
    val appVersion: String,
    val ingestionMode: String = "NOTIFICATION_LISTENER"
)

interface PairingTransport {
    suspend fun requestChallenge(
        enrollmentToken: String,
        publicKeyPem: String,
        expectedOrganizationId: String?
    ): Result<PairingChallengePayload>

    suspend fun submitPairProof(request: PairSubmissionPayload): Result<PairingCompletionPayload>
}

interface PairingStateSink {
    fun persistEnrolledDevice(result: PairingCompletionPayload)
}

/**
 * Coordinates the 2-step challenge-response Proof-of-Possession pairing ceremony.
 * Guarantees that local paired state is NEVER persisted until the server confirms verification,
 * and handles expired challenges and transient failures safely without duplicate registrations.
 */
class DevicePairingCoordinator(
    private val keyProvider: DeviceKeyProvider,
    private val transport: PairingTransport,
    private val stateSink: PairingStateSink
) {

    suspend fun enroll(
        enrollmentToken: String,
        expectedOrganizationId: String?,
        label: String,
        deviceModel: String,
        manufacturer: String,
        androidVersion: String,
        appVersion: String,
        ingestionMode: String = "NOTIFICATION_LISTENER",
        maxExpiredRetries: Int = 1
    ): Result<PairingCompletionPayload> {
        val publicKeyPem = keyProvider.getPublicKeyPem()
        val localFingerprint = keyProvider.getPublicKeyFingerprintHex()

        val maxAttempts = (1 + maxExpiredRetries).coerceAtLeast(1)
        var lastError: Throwable? = null

        for (attempt in 1..maxAttempts) {
            val challengeResult = transport.requestChallenge(
                enrollmentToken = enrollmentToken,
                publicKeyPem = publicKeyPem,
                expectedOrganizationId = expectedOrganizationId
            )

            val challenge = challengeResult.getOrElse { err ->
                return Result.failure(err)
            }

            val validation = DevicePairingProtocol.validateChallengeResponse(
                expectedOrgId = expectedOrganizationId,
                localPublicKeyFingerprint = localFingerprint,
                challenge = challenge
            )
            if (validation.isFailure) {
                val err = validation.exceptionOrNull()!!
                if (err is PairingApiException &&
                    err.errorCode == DevicePairingProtocol.ERROR_CHALLENGE_EXPIRED &&
                    attempt < maxAttempts
                ) {
                    lastError = err
                    continue
                }
                return Result.failure(err)
            }

            val canonicalBytes = DevicePairingProtocol.buildCanonicalSigningPayload(
                challengeId = challenge.challengeId,
                enrollmentId = challenge.enrollmentId,
                organizationId = challenge.organizationId,
                enrollmentToken = enrollmentToken,
                publicKeyFingerprint = localFingerprint,
                keyAlgorithm = DevicePairingProtocol.KEY_ALGORITHM,
                signatureAlgorithm = DevicePairingProtocol.SIGNATURE_ALGORITHM,
                challengeNonce = challenge.challenge,
                expiresAt = challenge.expiresAt
            )

            val signature = keyProvider.sign(canonicalBytes)

            val submission = PairSubmissionPayload(
                enrollmentToken = enrollmentToken,
                challengeId = challenge.challengeId,
                enrollmentId = challenge.enrollmentId,
                organizationId = challenge.organizationId,
                keyAlgorithm = DevicePairingProtocol.KEY_ALGORITHM,
                signatureAlgorithm = DevicePairingProtocol.SIGNATURE_ALGORITHM,
                challengeSignature = signature,
                publicKeyPem = publicKeyPem,
                label = label,
                deviceModel = deviceModel,
                manufacturer = manufacturer,
                androidVersion = androidVersion,
                appVersion = appVersion,
                ingestionMode = ingestionMode
            )

            val pairResult = transport.submitPairProof(submission)
            if (pairResult.isSuccess) {
                val enrolled = pairResult.getOrThrow()
                stateSink.persistEnrolledDevice(enrolled)
                return Result.success(enrolled)
            }

            val err = pairResult.exceptionOrNull()!!
            lastError = err

            val isExpiredChallenge = err is PairingApiException &&
                err.errorCode == DevicePairingProtocol.ERROR_CHALLENGE_EXPIRED
            if (isExpiredChallenge && attempt < maxAttempts) {
                continue
            }

            return Result.failure(err)
        }

        return Result.failure(lastError ?: IllegalStateException("Pairing failed"))
    }
}
