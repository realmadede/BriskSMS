package tz.co.brisksms.security

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.security.spec.X509EncodedKeySpec
import java.time.Instant
import java.util.Base64
import java.util.UUID

class DevicePairingProofOfPossessionTest {

    private fun generateTestP256Provider(): Pair<DeviceKeyProvider, java.security.PublicKey> {
        val kpg = KeyPairGenerator.getInstance("EC")
        kpg.initialize(ECGenParameterSpec("secp256r1"))
        val kp = kpg.generateKeyPair()

        val provider = object : DeviceKeyProvider {
            override fun getPublicKeyPem(): String = DevicePairingProtocol.encodePublicKeyPem(kp.public.encoded)
            override fun getPublicKeyFingerprintHex(): String =
                DevicePairingProtocol.computePublicKeyFingerprint(kp.public.encoded)

            override fun sign(data: ByteArray): String {
                val sig = Signature.getInstance("SHA256withECDSA")
                sig.initSign(kp.private)
                sig.update(data)
                return Base64.getEncoder().encodeToString(sig.sign())
            }
        }
        return Pair(provider, kp.public)
    }

    @Test
    fun enroll_executesValidChallengeResponsePopAndNeverExposesPrivateKey() = runBlocking {
        val (keyProvider, publicKey) = generateTestP256Provider()
        val expectedOrgId = UUID.randomUUID().toString()
        val enrollmentToken = "bsk_pair_testtoken001"
        val issuedAt = Instant.now()
        val expiresAt = issuedAt.plusSeconds(120)
        val challengeNonce = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(32) { 0x42 })

        var persistedResult: PairingCompletionPayload? = null
        var capturedProof: PairSubmissionPayload? = null

        val transport = object : PairingTransport {
            override suspend fun requestChallenge(
                enrollmentToken: String,
                publicKeyPem: String,
                expectedOrganizationId: String?
            ): Result<PairingChallengePayload> {
                assertFalse(publicKeyPem.contains("PRIVATE KEY"))
                return Result.success(
                    PairingChallengePayload(
                        protocolVersion = DevicePairingProtocol.PROTOCOL_VERSION,
                        challengeId = UUID.randomUUID().toString(),
                        enrollmentId = UUID.randomUUID().toString(),
                        organizationId = expectedOrgId,
                        challenge = challengeNonce,
                        publicKeyFingerprint = keyProvider.getPublicKeyFingerprintHex(),
                        keyAlgorithm = DevicePairingProtocol.KEY_ALGORITHM,
                        signatureAlgorithm = DevicePairingProtocol.SIGNATURE_ALGORITHM,
                        issuedAt = issuedAt.toString(),
                        expiresAt = expiresAt.toString()
                    )
                )
            }

            override suspend fun submitPairProof(request: PairSubmissionPayload): Result<PairingCompletionPayload> {
                capturedProof = request
                assertFalse(request.publicKeyPem.contains("PRIVATE KEY"))
                assertNull(persistedResult) // Must not mark paired locally before server confirms
                return Result.success(
                    PairingCompletionPayload(
                        deviceId = "dev_001",
                        organizationId = expectedOrgId,
                        deviceToken = "bsk_dev_secret_token",
                        publicKeyFingerprint = keyProvider.getPublicKeyFingerprintHex(),
                        keyAlgorithm = DevicePairingProtocol.KEY_ALGORITHM,
                        syncIntervalSeconds = 30
                    )
                )
            }
        }

        val coordinator = DevicePairingCoordinator(
            keyProvider = keyProvider,
            transport = transport,
            stateSink = object : PairingStateSink {
                override fun persistEnrolledDevice(result: PairingCompletionPayload) {
                    persistedResult = result
                }
            }
        )

        val result = coordinator.enroll(
            enrollmentToken = enrollmentToken,
            expectedOrganizationId = expectedOrgId,
            label = "Dar Till #1",
            deviceModel = "SM-A155F",
            manufacturer = "Samsung",
            androidVersion = "14",
            appVersion = "1.0.0"
        )

        assertTrue(result.isSuccess)
        assertEquals("dev_001", persistedResult?.deviceId)
        val proof = capturedProof!!

        // Independently verify canonical transcript signature with public key
        val verifier = Signature.getInstance("SHA256withECDSA")
        verifier.initVerify(publicKey)
        val expectedTranscript = DevicePairingProtocol.buildCanonicalSigningPayload(
            challengeId = proof.challengeId,
            enrollmentId = proof.enrollmentId,
            organizationId = expectedOrgId,
            enrollmentToken = enrollmentToken,
            publicKeyFingerprint = keyProvider.getPublicKeyFingerprintHex(),
            keyAlgorithm = proof.keyAlgorithm,
            signatureAlgorithm = proof.signatureAlgorithm,
            challengeNonce = challengeNonce,
            expiresAt = expiresAt.toString()
        )
        verifier.update(expectedTranscript)
        assertTrue(verifier.verify(Base64.getDecoder().decode(proof.challengeSignature)))
    }

    @Test
    fun enroll_rejectsPublicKeyOrOrganizationSubstitutionAndDoesNotPersistLocalState() = runBlocking {
        val (keyProvider, _) = generateTestP256Provider()
        val expectedOrgId = UUID.randomUUID().toString()
        var persisted = false
        var submitCalled = false

        val transport = object : PairingTransport {
            override suspend fun requestChallenge(
                enrollmentToken: String,
                publicKeyPem: String,
                expectedOrganizationId: String?
            ): Result<PairingChallengePayload> {
                return Result.success(
                    PairingChallengePayload(
                        protocolVersion = DevicePairingProtocol.PROTOCOL_VERSION,
                        challengeId = UUID.randomUUID().toString(),
                        enrollmentId = UUID.randomUUID().toString(),
                        organizationId = expectedOrgId,
                        challenge = "nonce_abc",
                        publicKeyFingerprint = "0000000000000000000000000000000000000000000000000000000000000000",
                        keyAlgorithm = DevicePairingProtocol.KEY_ALGORITHM,
                        signatureAlgorithm = DevicePairingProtocol.SIGNATURE_ALGORITHM,
                        issuedAt = Instant.now().toString(),
                        expiresAt = Instant.now().plusSeconds(60).toString()
                    )
                )
            }

            override suspend fun submitPairProof(request: PairSubmissionPayload): Result<PairingCompletionPayload> {
                submitCalled = true
                return Result.failure(IOException("Should not submit"))
            }
        }

        val coordinator = DevicePairingCoordinator(
            keyProvider = keyProvider,
            transport = transport,
            stateSink = object : PairingStateSink {
                override fun persistEnrolledDevice(result: PairingCompletionPayload) {
                    persisted = true
                }
            }
        )

        val result = coordinator.enroll(
            enrollmentToken = "bsk_pair_abc",
            expectedOrganizationId = expectedOrgId,
            label = "Test",
            deviceModel = "Pixel",
            manufacturer = "Google",
            androidVersion = "14",
            appVersion = "1.0.0"
        )

        assertTrue(result.isFailure)
        assertFalse(submitCalled)
        assertFalse(persisted)
    }

    @Test
    fun enroll_retriesOnceSafelyOnExpiredChallengeAndKeepsUnpairedOnNetworkFailure() = runBlocking {
        val (keyProvider, _) = generateTestP256Provider()
        val orgId = UUID.randomUUID().toString()
        var challengeCalls = 0
        var pairCalls = 0
        var persistedCount = 0

        val transport = object : PairingTransport {
            override suspend fun requestChallenge(
                enrollmentToken: String,
                publicKeyPem: String,
                expectedOrganizationId: String?
            ): Result<PairingChallengePayload> {
                challengeCalls++
                return Result.success(
                    PairingChallengePayload(
                        protocolVersion = DevicePairingProtocol.PROTOCOL_VERSION,
                        challengeId = UUID.randomUUID().toString(),
                        enrollmentId = UUID.randomUUID().toString(),
                        organizationId = orgId,
                        challenge = "nonce_$challengeCalls",
                        publicKeyFingerprint = keyProvider.getPublicKeyFingerprintHex(),
                        keyAlgorithm = DevicePairingProtocol.KEY_ALGORITHM,
                        signatureAlgorithm = DevicePairingProtocol.SIGNATURE_ALGORITHM,
                        issuedAt = Instant.now().toString(),
                        expiresAt = Instant.now().plusSeconds(60).toString()
                    )
                )
            }

            override suspend fun submitPairProof(request: PairSubmissionPayload): Result<PairingCompletionPayload> {
                pairCalls++
                return if (pairCalls == 1) {
                    Result.failure(PairingApiException(401, DevicePairingProtocol.ERROR_CHALLENGE_EXPIRED, "Expired"))
                } else {
                    Result.success(
                        PairingCompletionPayload(
                            deviceId = "dev_retry_ok",
                            organizationId = orgId,
                            deviceToken = "bsk_dev_retry_ok",
                            publicKeyFingerprint = keyProvider.getPublicKeyFingerprintHex(),
                            keyAlgorithm = DevicePairingProtocol.KEY_ALGORITHM,
                            syncIntervalSeconds = 30
                        )
                    )
                }
            }
        }

        val coordinator = DevicePairingCoordinator(
            keyProvider = keyProvider,
            transport = transport,
            stateSink = object : PairingStateSink {
                override fun persistEnrolledDevice(result: PairingCompletionPayload) {
                    persistedCount++
                }
            }
        )

        val result = coordinator.enroll(
            enrollmentToken = "bsk_pair_retry",
            expectedOrganizationId = orgId,
            label = "Retry Phone",
            deviceModel = "Pixel",
            manufacturer = "Google",
            androidVersion = "14",
            appVersion = "1.0.0"
        )

        assertTrue(result.isSuccess)
        assertEquals(2, challengeCalls)
        assertEquals(2, pairCalls)
        assertEquals(1, persistedCount)
    }

    @Test
    fun enroll_networkFailureNeverMarksDevicePairedLocally() = runBlocking {
        val (keyProvider, _) = generateTestP256Provider()
        val orgId = UUID.randomUUID().toString()
        var persistedCount = 0

        val transport = object : PairingTransport {
            override suspend fun requestChallenge(
                enrollmentToken: String,
                publicKeyPem: String,
                expectedOrganizationId: String?
            ): Result<PairingChallengePayload> {
                return Result.success(
                    PairingChallengePayload(
                        protocolVersion = DevicePairingProtocol.PROTOCOL_VERSION,
                        challengeId = UUID.randomUUID().toString(),
                        enrollmentId = UUID.randomUUID().toString(),
                        organizationId = orgId,
                        challenge = "nonce_net_fail",
                        publicKeyFingerprint = keyProvider.getPublicKeyFingerprintHex(),
                        keyAlgorithm = DevicePairingProtocol.KEY_ALGORITHM,
                        signatureAlgorithm = DevicePairingProtocol.SIGNATURE_ALGORITHM,
                        issuedAt = Instant.now().toString(),
                        expiresAt = Instant.now().plusSeconds(60).toString()
                    )
                )
            }

            override suspend fun submitPairProof(request: PairSubmissionPayload): Result<PairingCompletionPayload> {
                return Result.failure(IOException("Connection timed out"))
            }
        }

        val coordinator = DevicePairingCoordinator(
            keyProvider = keyProvider,
            transport = transport,
            stateSink = object : PairingStateSink {
                override fun persistEnrolledDevice(result: PairingCompletionPayload) {
                    persistedCount++
                }
            }
        )

        val result = coordinator.enroll(
            enrollmentToken = "bsk_pair_netfail",
            expectedOrganizationId = orgId,
            label = "NetFail Phone",
            deviceModel = "Pixel",
            manufacturer = "Google",
            androidVersion = "14",
            appVersion = "1.0.0"
        )

        assertTrue(result.isFailure)
        assertEquals(0, persistedCount)
    }

    @Test
    fun canonicalTranscript_preventsDelimiterAmbiguity() {
        val a = DevicePairingProtocol.buildCanonicalSigningPayload(
            challengeId = "ch|1",
            enrollmentId = "en",
            organizationId = "org",
            enrollmentToken = "tok",
            publicKeyFingerprint = "fp",
            keyAlgorithm = "EC_P256",
            signatureAlgorithm = "SHA256_ECDSA",
            challengeNonce = "n",
            expiresAt = "2026-11-14T12:00:00.000Z"
        )
        val b = DevicePairingProtocol.buildCanonicalSigningPayload(
            challengeId = "ch",
            enrollmentId = "1|en",
            organizationId = "org",
            enrollmentToken = "tok",
            publicKeyFingerprint = "fp",
            keyAlgorithm = "EC_P256",
            signatureAlgorithm = "SHA256_ECDSA",
            challengeNonce = "n",
            expiresAt = "2026-11-14T12:00:00.000Z"
        )
        assertFalse(a.contentEquals(b))
    }

    @Test
    fun crossLanguageVector_matchesBackendTranscriptAndEcdsaSignatureByteForByte() {
        val spkiBase64 =
            "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEfaAtwTSAkNeIPdbRfZcPR0s2YC7ccIGemkjILeyHQZLz7kjfZKksl+NiRBnpyS/f44pemm87Pe2MyrXsPcyGLQ=="
        val expectedPem =
            "-----BEGIN PUBLIC KEY-----\n" +
                "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEfaAtwTSAkNeIPdbRfZcPR0s2YC7c\n" +
                "cIGemkjILeyHQZLz7kjfZKksl+NiRBnpyS/f44pemm87Pe2MyrXsPcyGLQ==\n" +
                "-----END PUBLIC KEY-----"
        val expectedFingerprint = "5caa2a11c88c7a0e71859fcdebccaa1d01abe40261e6eed39c9ad96349e4f25e"
        val enrollmentToken = "bsk_pair_crosslang_vector_001"
        val expectedTokenHash = "f38e1b49dae424cd13d3c3d551f39ab4f9907e9304f5cc94e9b653d66304a6f3"
        val expectedTranscriptHex =
            "0000001e425249534b534d532d4445564943452d50414952494e472d504f502d5631" +
                "0000002431313131313131312d313131312d343131312d383131312d313131313131313131313131" +
                "0000002432323232323232322d323232322d343232322d383232322d323232323232323232323232" +
                "0000002433333333333333332d333333332d343333332d383333332d333333333333333333333333" +
                "0000004066333865316234396461653432346364313364336333643535316633396162346639393037653933303466356363393465396236353364363633303461366633" +
                "0000004035636161326131316338386337613065373138353966636465626363616131643031616265343032363165366565643339633961643936333439653466323565" +
                "0000000745435f50323536" +
                "0000000c5348413235365f4543445341" +
                "0000002b59574a6a5a47566d5a326870616d7473625735766348467963335231646e643465586f774d54497a4e4455" +
                "00000018323032362d31312d31345431323a30303a30302e3132335a"
        val backendSigBase64 =
            "MEQCIGxGKxwg45gNgviFTwPvwochwdv03715/GHAvG75nGLjAiAPldNfxsjytvwe0YXTBlw+C8CPm+Sw9knzQQ3QqVwJlA=="

        val spkiDer = Base64.getDecoder().decode(spkiBase64)
        assertEquals(91, spkiDer.size)
        assertEquals(expectedPem, DevicePairingProtocol.encodePublicKeyPem(spkiDer))
        assertEquals(expectedFingerprint, DevicePairingProtocol.computePublicKeyFingerprint(spkiDer))
        assertEquals(expectedTokenHash, DevicePairingProtocol.sha256Hex(enrollmentToken.toByteArray(Charsets.UTF_8)))

        val transcript = DevicePairingProtocol.buildCanonicalSigningPayload(
            challengeId = "11111111-1111-4111-8111-111111111111",
            enrollmentId = "22222222-2222-4222-8222-222222222222",
            organizationId = "33333333-3333-4333-8333-333333333333",
            enrollmentToken = enrollmentToken,
            publicKeyFingerprint = expectedFingerprint,
            keyAlgorithm = DevicePairingProtocol.KEY_ALGORITHM,
            signatureAlgorithm = DevicePairingProtocol.SIGNATURE_ALGORITHM,
            challengeNonce = "YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU",
            expiresAt = "2026-11-14T12:00:00.123Z"
        )
        assertEquals(392, transcript.size)
        val actualHex = transcript.joinToString("") { "%02x".format(it) }
        assertEquals(expectedTranscriptHex, actualHex)
        assertEquals(
            "a6d6f93a7079c6baa093e5b8a041d7c2a8f955bf2d528cefd9f94cb006bc44fc",
            DevicePairingProtocol.sha256Hex(transcript)
        )

        val publicKey = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(spkiDer))
        val verifier = Signature.getInstance("SHA256withECDSA")
        verifier.initVerify(publicKey)
        verifier.update(transcript)
        assertTrue(verifier.verify(Base64.getDecoder().decode(backendSigBase64)))
    }
}
