package tz.co.brisksms.core.network

import android.os.Build
import android.util.Log
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONObject
import tz.co.brisksms.core.storage.KeystoreSecureStorage
import tz.co.brisksms.messaging.AcquireOutboundSmsJobsResponse
import tz.co.brisksms.messaging.OutboundSmsDispatchingResult
import tz.co.brisksms.messaging.OutboundSmsJobPayload
import tz.co.brisksms.messaging.OutboundSmsJobResultAck
import tz.co.brisksms.messaging.OutboundSmsJobResultReport
import tz.co.brisksms.security.DevicePairingProtocol
import tz.co.brisksms.security.PairSubmissionPayload
import tz.co.brisksms.security.PairingApiException
import tz.co.brisksms.security.PairingChallengePayload
import tz.co.brisksms.security.PairingCompletionPayload
import tz.co.brisksms.security.PairingTransport
import java.io.IOException
import java.util.concurrent.TimeUnit

typealias PairDeviceRequest = PairSubmissionPayload
typealias PairDeviceResponse = PairingCompletionPayload

data class IngestionEvidenceRequest(
    val senderAddress: String,
    val rawPayload: String,
    val simSlot: Int = 1,
    val deviceTimestamp: String,
    val signature: String? = null
)

data class IngestionAckResponse(
    val acknowledged: Boolean,
    val evidenceId: String,
    val deduplicationHash: String?,
    val status: String
)

data class DeviceCommandAckPayload(
    val commandId: String,
    val status: String,
    val leaseToken: String? = null,
    val failureReason: String? = null
)

data class DeviceCommandAckOutcome(
    val commandId: String,
    val accepted: Boolean,
    val status: String? = null,
    val errorCode: String? = null
)

data class DeviceTelemetryRequest(
    val batteryPercentage: Int,
    val isCharging: Boolean,
    val networkType: String,
    val signalStrengthDbm: Int? = null,
    val pendingOfflineCount: Int = 0,
    val commandAcknowledgements: List<DeviceCommandAckPayload> = emptyList()
)

data class DeviceCommandPayload(
    val id: String,
    val type: String,
    val payload: JSONObject? = null,
    val leaseToken: String? = null
)

data class DeviceTelemetryResponse(
    val acknowledged: Boolean,
    val commands: List<DeviceCommandPayload> = emptyList(),
    val ackResults: List<DeviceCommandAckOutcome> = emptyList()
)

data class CommandAckResult(
    val accepted: Boolean,
    val retryable: Boolean,
    val errorCode: String? = null
)

class EvidenceUploadException(
    val errorCode: String,
    val retryable: Boolean,
    val permanentFailure: Boolean,
    message: String
) : IOException(message)

sealed class UploadResponseClassification {
    data class Accepted(val ack: IngestionAckResponse) : UploadResponseClassification()
    data class Rejected(
        val errorCode: String,
        val retryable: Boolean,
        val permanentFailure: Boolean,
        val message: String
    ) : UploadResponseClassification()
}

/**
 * Universal Secure Network Client for BriskSMS Android
 * Enforces TLS, device Bearer token authentication, timeout policies, and structured error responses.
 */
class BriskApiClient(private val secureStorage: KeystoreSecureStorage) : PairingTransport {

    companion object {
        private const val TAG = "BriskApiClient"
        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
        private const val USER_AGENT = "BriskSMS-Android/1.0.0"

        private fun JsonObject.optStringOrNull(memberName: String): String? {
            val elem = get(memberName)
            if (elem == null || elem.isJsonNull || !elem.isJsonPrimitive) return null
            return elem.asString.takeIf { it.isNotBlank() }
        }

        private fun JsonObject.optObjectOrNull(memberName: String): JsonObject? {
            val elem = get(memberName)
            return if (elem != null && elem.isJsonObject) elem.asJsonObject else null
        }

        fun classifyEvidenceUploadResponse(statusCode: Int, bodyStr: String): UploadResponseClassification {
            val json = runCatching {
                if (bodyStr.isNotBlank()) JsonParser.parseString(bodyStr)?.takeIf { it.isJsonObject }?.asJsonObject else null
            }.getOrNull() ?: JsonObject()

            val errObj = json.optObjectOrNull("error")
            val errorCode = errObj?.optStringOrNull("code") ?: "HTTP_$statusCode"
            val errorMsg = errObj?.optStringOrNull("message")
                ?: json.optStringOrNull("message")
                ?: "Upload failed with HTTP $statusCode"

            if (statusCode in 200..299) {
                val data = json.optObjectOrNull("data")
                val status = data?.optStringOrNull("status") ?: "OBSERVED"
                val evidenceId = data?.optStringOrNull("evidenceId") ?: "ack_${System.currentTimeMillis()}"
                val hash = data?.optStringOrNull("deduplicationHash")
                return UploadResponseClassification.Accepted(
                    IngestionAckResponse(
                        acknowledged = true,
                        evidenceId = evidenceId,
                        deduplicationHash = hash,
                        status = status
                    )
                )
            }

            if (statusCode == 409) {
                if (errorCode == "CROSS_TENANT_DISPUTE" || bodyStr.contains("CROSS_TENANT_DISPUTE")) {
                    return UploadResponseClassification.Rejected(
                        errorCode = "CROSS_TENANT_DISPUTE",
                        retryable = false,
                        permanentFailure = true,
                        message = errorMsg
                    )
                }
                val data = json.optObjectOrNull("data")
                val evidenceId = data?.optStringOrNull("evidenceId") ?: "dup_${System.currentTimeMillis()}"
                val hash = data?.optStringOrNull("deduplicationHash")
                return UploadResponseClassification.Accepted(
                    IngestionAckResponse(
                        acknowledged = true,
                        evidenceId = evidenceId,
                        deduplicationHash = hash,
                        status = data?.optStringOrNull("status") ?: "DUPLICATE"
                    )
                )
            }

            val retryable = statusCode == 408 || statusCode == 429 || statusCode >= 500
            val permanentFailure = statusCode == 400 || statusCode == 404 || statusCode == 422
            return UploadResponseClassification.Rejected(
                errorCode = errorCode,
                retryable = retryable,
                permanentFailure = permanentFailure,
                message = errorMsg
            )
        }
    }

    private val authInterceptor = Interceptor { chain ->
        val original = chain.request()
        val requestBuilder = original.newBuilder()
            .header("User-Agent", USER_AGENT)
            .header("Accept", "application/json")

        val token = secureStorage.deviceToken
        if (token != null && !secureStorage.isRevoked && original.header("Authorization") == null) {
            requestBuilder.header("Authorization", "Bearer $token")
        }

        val response = chain.proceed(requestBuilder.build())

        // Handle device revocation globally and clear stale device credentials
        if (response.code == 403) {
            try {
                val peekBody = response.peekBody(2048).string()
                if (peekBody.contains("DEVICE_REVOKED")) {
                    Log.w(TAG, "Device revocation detected from backend. Clearing revoked credential.")
                    secureStorage.clearRevokedIdentity()
                }
            } catch (e: Exception) {
                // Ignore peek exceptions
            }
        }

        response
    }

    private val okHttpClient = OkHttpClient.Builder()
        .addInterceptor(authInterceptor)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(25, TimeUnit.SECONDS)
        .writeTimeout(25, TimeUnit.SECONDS)
        .build()

    private fun getBaseUrl(): String {
        return secureStorage.apiBaseUrl
    }

    /**
     * Step 1 of Proof-of-Possession enrollment: requests a single-use server pairing challenge
     * bound to the enrollment token and device public key (POST /v1/devices/pairing-challenge).
     */
    override suspend fun requestChallenge(
        enrollmentToken: String,
        publicKeyPem: String,
        expectedOrganizationId: String?
    ): Result<PairingChallengePayload> {
        return try {
            val endpoint = "${getBaseUrl()}/v1/devices/pairing-challenge"
            val bodyJson = JSONObject().apply {
                put("enrollmentToken", enrollmentToken)
                put("publicKeyPem", publicKeyPem)
                put("keyAlgorithm", DevicePairingProtocol.KEY_ALGORITHM)
                put("signatureAlgorithm", DevicePairingProtocol.SIGNATURE_ALGORITHM)
                if (!expectedOrganizationId.isNullOrBlank()) {
                    put("organizationId", expectedOrganizationId)
                }
            }

            val httpRequest = Request.Builder()
                .url(endpoint)
                .post(bodyJson.toString().toRequestBody(JSON_MEDIA_TYPE))
                .build()

            okHttpClient.newCall(httpRequest).execute().use { response ->
                val bodyStr = response.body?.string() ?: ""
                if (!response.isSuccessful) {
                    return Result.failure(
                        buildApiException(response.code, bodyStr, "Challenge request failed with HTTP ${response.code}")
                    )
                }

                val json = JSONObject(bodyStr)
                val data = json.getJSONObject("data")
                Result.success(
                    PairingChallengePayload(
                        protocolVersion = data.getString("protocolVersion"),
                        challengeId = data.getString("challengeId"),
                        enrollmentId = data.getString("enrollmentId"),
                        organizationId = data.getString("organizationId"),
                        challenge = data.getString("challenge"),
                        publicKeyFingerprint = data.getString("publicKeyFingerprint"),
                        keyAlgorithm = data.getString("keyAlgorithm"),
                        signatureAlgorithm = data.getString("signatureAlgorithm"),
                        issuedAt = data.getString("issuedAt"),
                        expiresAt = data.getString("expiresAt")
                    )
                )
            }
        } catch (e: Exception) {
            Log.e(TAG, "Exception requesting pairing challenge: ${e.message}")
            Result.failure(e)
        }
    }

    /**
     * Step 2 of Proof-of-Possession enrollment: submits ECDSA challenge signature (POST /v1/devices/pair).
     */
    override suspend fun submitPairProof(request: PairSubmissionPayload): Result<PairingCompletionPayload> {
        return pairDevice(request)
    }

    /**
     * Executes device pairing proof submission (POST /v1/devices/pair)
     */
    suspend fun pairDevice(request: PairDeviceRequest): Result<PairDeviceResponse> {
        return try {
            val endpoint = "${getBaseUrl()}/v1/devices/pair"
            val bodyJson = JSONObject().apply {
                put("enrollmentToken", request.enrollmentToken)
                put("challengeId", request.challengeId)
                put("enrollmentId", request.enrollmentId)
                put("organizationId", request.organizationId)
                put("keyAlgorithm", request.keyAlgorithm)
                put("signatureAlgorithm", request.signatureAlgorithm)
                put("challengeSignature", request.challengeSignature)
                put("label", request.label)
                put("publicKeyPem", request.publicKeyPem)
                put("deviceModel", request.deviceModel)
                put("manufacturer", request.manufacturer)
                put("androidVersion", request.androidVersion)
                put("appVersion", request.appVersion)
                put("ingestionMode", request.ingestionMode)
            }

            val httpRequest = Request.Builder()
                .url(endpoint)
                .post(bodyJson.toString().toRequestBody(JSON_MEDIA_TYPE))
                .build()

            okHttpClient.newCall(httpRequest).execute().use { response ->
                val bodyStr = response.body?.string() ?: ""
                if (!response.isSuccessful) {
                    return Result.failure(
                        buildApiException(response.code, bodyStr, "Pairing failed with HTTP ${response.code}")
                    )
                }

                val json = JSONObject(bodyStr)
                val data = json.getJSONObject("data")
                val result = PairDeviceResponse(
                    deviceId = data.getString("deviceId"),
                    organizationId = data.getString("organizationId"),
                    deviceToken = data.getString("deviceToken"),
                    publicKeyFingerprint = data.optString("publicKeyFingerprint", ""),
                    keyAlgorithm = data.optString("keyAlgorithm", DevicePairingProtocol.KEY_ALGORITHM),
                    syncIntervalSeconds = data.optInt("syncIntervalSeconds", 30)
                )
                Result.success(result)
            }
        } catch (e: Exception) {
            Log.e(TAG, "Exception during device pairing: ${e.message}")
            Result.failure(e)
        }
    }

    /**
     * Uploads normalized payment notification evidence (POST /v1/ingestion/evidence)
     */
    suspend fun uploadEvidence(evidence: IngestionEvidenceRequest): Result<IngestionAckResponse> {
        return try {
            if (secureStorage.isRevoked) {
                return Result.failure(IllegalStateException("Device is revoked"))
            }

            val endpoint = "${getBaseUrl()}/v1/ingestion/evidence"
            val bodyJson = JSONObject().apply {
                put("senderAddress", evidence.senderAddress)
                put("rawPayload", evidence.rawPayload)
                put("simSlot", evidence.simSlot)
                put("deviceTimestamp", evidence.deviceTimestamp)
                if (evidence.signature != null) {
                    put("signature", evidence.signature)
                }
            }

            val httpRequest = Request.Builder()
                .url(endpoint)
                .post(bodyJson.toString().toRequestBody(JSON_MEDIA_TYPE))
                .build()

            okHttpClient.newCall(httpRequest).execute().use { response ->
                val bodyStr = response.body?.string() ?: ""
                when (val classified = classifyEvidenceUploadResponse(response.code, bodyStr)) {
                    is UploadResponseClassification.Accepted -> Result.success(classified.ack)
                    is UploadResponseClassification.Rejected -> Result.failure(
                        EvidenceUploadException(
                            errorCode = classified.errorCode,
                            retryable = classified.retryable,
                            permanentFailure = classified.permanentFailure,
                            message = classified.message
                        )
                    )
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Exception during evidence upload: ${e.message}")
            Result.failure(e)
        }
    }

    /**
     * Reports device operational health & telemetry (POST /v1/devices/:id/telemetry)
     */
    suspend fun sendTelemetry(telemetry: DeviceTelemetryRequest): Result<DeviceTelemetryResponse> {
        return try {
            val deviceId = secureStorage.deviceId ?: return Result.failure(IllegalStateException("Device not paired"))
            val endpoint = "${getBaseUrl()}/v1/devices/$deviceId/telemetry"

            val bodyJson = JSONObject().apply {
                put("batteryPercentage", telemetry.batteryPercentage)
                put("isCharging", telemetry.isCharging)
                put("networkType", telemetry.networkType)
                if (telemetry.signalStrengthDbm != null) {
                    put("signalStrengthDbm", telemetry.signalStrengthDbm)
                }
                put("pendingOfflineCount", telemetry.pendingOfflineCount)
                if (telemetry.commandAcknowledgements.isNotEmpty()) {
                    val ackArray = JSONArray()
                    for (ack in telemetry.commandAcknowledgements) {
                        ackArray.put(JSONObject().apply {
                            put("commandId", ack.commandId)
                            put("status", ack.status)
                            if (ack.leaseToken != null) {
                                put("leaseToken", ack.leaseToken)
                            }
                            if (ack.failureReason != null) {
                                put("failureReason", ack.failureReason)
                            }
                        })
                    }
                    put("commandAcknowledgements", ackArray)
                }
            }

            val httpRequest = Request.Builder()
                .url(endpoint)
                .post(bodyJson.toString().toRequestBody(JSON_MEDIA_TYPE))
                .build()

            okHttpClient.newCall(httpRequest).execute().use { response ->
                if (response.isSuccessful) {
                    val bodyStr = response.body?.string() ?: ""
                    val commandsList = mutableListOf<DeviceCommandPayload>()
                    val ackOutcomesList = mutableListOf<DeviceCommandAckOutcome>()
                    if (bodyStr.isNotEmpty()) {
                        try {
                            val json = JSONObject(bodyStr)
                            val dataObj = json.optJSONObject("data") ?: json
                            val cmdsArray = dataObj.optJSONArray("commands")
                            if (cmdsArray != null) {
                                for (i in 0 until cmdsArray.length()) {
                                    val cmdObj = cmdsArray.getJSONObject(i)
                                    val lease = if (cmdObj.isNull("leaseToken")) null else cmdObj.optString("leaseToken", "").ifEmpty { null }
                                    commandsList.add(
                                        DeviceCommandPayload(
                                            id = cmdObj.optString("id"),
                                            type = cmdObj.optString("type"),
                                            payload = cmdObj.optJSONObject("payload"),
                                            leaseToken = lease
                                        )
                                    )
                                }
                            }
                            val ackArray = dataObj.optJSONArray("ackResults")
                            if (ackArray != null) {
                                for (i in 0 until ackArray.length()) {
                                    val ackObj = ackArray.getJSONObject(i)
                                    val statusVal = if (ackObj.isNull("status")) null else ackObj.optString("status", "").ifEmpty { null }
                                    val errVal = if (ackObj.isNull("errorCode")) null else ackObj.optString("errorCode", "").ifEmpty { null }
                                    ackOutcomesList.add(
                                        DeviceCommandAckOutcome(
                                            commandId = ackObj.optString("commandId"),
                                            accepted = ackObj.optBoolean("accepted", false),
                                            status = statusVal,
                                            errorCode = errVal
                                        )
                                    )
                                }
                            }
                        } catch (e: Exception) {
                            Log.w(TAG, "Failed parsing telemetry response commands: ${e.message}")
                        }
                    }
                    Result.success(
                        DeviceTelemetryResponse(
                            acknowledged = true,
                            commands = commandsList,
                            ackResults = ackOutcomesList
                        )
                    )
                } else {
                    Result.failure(IOException("Telemetry failed with HTTP ${response.code}"))
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Telemetry upload exception: ${e.message}")
            Result.failure(e)
        }
    }

    /**
     * Explicitly acknowledges execution (ACKNOWLEDGED or FAILED) of a delivered fleet command
     * via POST /v1/devices/:id/commands/:commandId/ack.
     */
    suspend fun acknowledgeCommand(ack: DeviceCommandAckPayload): CommandAckResult {
        val deviceId = secureStorage.deviceId
            ?: return CommandAckResult(accepted = false, retryable = true, errorCode = "DEVICE_NOT_PAIRED")
        val endpoint = "${getBaseUrl()}/v1/devices/$deviceId/commands/${ack.commandId}/ack"

        val bodyJson = JSONObject().apply {
            put("status", ack.status)
            if (ack.leaseToken != null) {
                put("leaseToken", ack.leaseToken)
            }
            if (ack.failureReason != null) {
                put("failureReason", ack.failureReason)
            }
        }

        val httpRequest = Request.Builder()
            .url(endpoint)
            .post(bodyJson.toString().toRequestBody(JSON_MEDIA_TYPE))
            .build()

        return try {
            okHttpClient.newCall(httpRequest).execute().use { response ->
                val bodyStr = response.body?.string() ?: ""
                if (response.isSuccessful) {
                    CommandAckResult(accepted = true, retryable = false)
                } else {
                    val errorCode = try {
                        val json = JSONObject(bodyStr)
                        json.optJSONObject("error")?.optString("code")?.ifEmpty { null }
                    } catch (_: Exception) {
                        null
                    }
                    // 4xx (except 408/429) indicates non-retryable terminal/validation rejection
                    val retryable = response.code == 408 || response.code == 429 || response.code >= 500
                    CommandAckResult(accepted = false, retryable = retryable, errorCode = errorCode ?: "HTTP_${response.code}")
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Command acknowledgement exception for ${ack.commandId}: ${e.message}")
            CommandAckResult(accepted = false, retryable = true, errorCode = "NETWORK_ERROR")
        }
    }

    /**
     * Leases pending Android outbound SMSGate jobs via POST /v1/messaging/device-jobs/acquire.
     */
    suspend fun acquireOutboundSmsJobs(
        limit: Int = 5,
        leaseSeconds: Int = 60,
        availableSimSlots: List<Int> = emptyList()
    ): Result<AcquireOutboundSmsJobsResponse> {
        if (!secureStorage.isPaired || secureStorage.isRevoked || secureStorage.deviceToken.isNullOrBlank()) {
            return Result.failure(IllegalStateException("Device not paired or revoked"))
        }

        return try {
            val endpoint = "${getBaseUrl()}/v1/messaging/device-jobs/acquire"
            val bodyJson = JSONObject().apply {
                put("limit", limit)
                put("leaseSeconds", leaseSeconds)
                if (availableSimSlots.isNotEmpty()) {
                    put("availableSimSlots", JSONArray(availableSimSlots))
                }
            }

            val httpRequest = Request.Builder()
                .url(endpoint)
                .post(bodyJson.toString().toRequestBody(JSON_MEDIA_TYPE))
                .build()

            okHttpClient.newCall(httpRequest).execute().use { response ->
                val bodyStr = response.body?.string() ?: ""
                if (!response.isSuccessful) {
                    val code = extractErrorCode(bodyStr) ?: "HTTP_${response.code}"
                    return Result.failure(PairingApiException(response.code, code, extractErrorMessage(bodyStr, "Acquire failed")))
                }

                val root = if (bodyStr.isNotEmpty()) JSONObject(bodyStr) else JSONObject()
                val dataObj = root.optJSONObject("data") ?: root
                val relayEnabled = dataObj.optBoolean("relayEnabled", true)
                val jobsArray = dataObj.optJSONArray("jobs") ?: JSONArray()
                val jobs = mutableListOf<OutboundSmsJobPayload>()

                for (i in 0 until jobsArray.length()) {
                    val item = jobsArray.getJSONObject(i)
                    jobs.add(
                        OutboundSmsJobPayload(
                            id = item.optString("id"),
                            organizationId = item.optString("organizationId"),
                            messageId = item.optString("messageId"),
                            recipientPhone = item.optString("recipientPhone"),
                            messageText = item.optString("messageText"),
                            simSlot = item.optInt("simSlot", 1),
                            leaseToken = item.optString("leaseToken", ""),
                            idempotencyKey = if (item.isNull("idempotencyKey")) null else item.optString("idempotencyKey", "").ifEmpty { null },
                            status = item.optString("status", "CLAIMED"),
                            leaseExpiresAt = if (item.isNull("leaseExpiresAt")) null else item.optString("leaseExpiresAt", "").ifEmpty { null },
                            expiresAt = if (item.isNull("expiresAt")) null else item.optString("expiresAt", "").ifEmpty { null },
                            attemptCount = item.optInt("attemptCount", 1),
                            maxAttempts = item.optInt("maxAttempts", 2)
                        )
                    )
                }

                Result.success(AcquireOutboundSmsJobsResponse(jobs = jobs, relayEnabled = relayEnabled))
            }
        } catch (e: Exception) {
            Log.w(TAG, "Acquire outbound SMS jobs exception: ${e.message}")
            Result.failure(e)
        }
    }

    /**
     * Records dispatch intent on the backend BEFORE invoking cellular SmsManager
     * via POST /v1/messaging/device-jobs/:jobId/dispatching.
     */
    suspend fun markOutboundSmsDispatching(
        jobId: String,
        leaseToken: String,
        simSlot: Int? = null
    ): OutboundSmsDispatchingResult {
        if (!secureStorage.isPaired || secureStorage.isRevoked) {
            return OutboundSmsDispatchingResult(
                accepted = false,
                retryable = false,
                errorCode = "DEVICE_NOT_AUTHORIZED",
                errorMessage = "Device is unpaired or revoked"
            )
        }

        val endpoint = "${getBaseUrl()}/v1/messaging/device-jobs/$jobId/dispatching"
        val bodyJson = JSONObject().apply {
            put("leaseToken", leaseToken)
            if (simSlot != null) {
                put("simSlot", simSlot)
            }
        }

        val httpRequest = Request.Builder()
            .url(endpoint)
            .post(bodyJson.toString().toRequestBody(JSON_MEDIA_TYPE))
            .build()

        return try {
            okHttpClient.newCall(httpRequest).execute().use { response ->
                val bodyStr = response.body?.string() ?: ""
                if (response.isSuccessful) {
                    val root = if (bodyStr.isNotEmpty()) JSONObject(bodyStr) else JSONObject()
                    val dataObj = root.optJSONObject("data") ?: root
                    val jobObj = dataObj.optJSONObject("job")
                    OutboundSmsDispatchingResult(
                        accepted = dataObj.optBoolean("accepted", true),
                        retryable = false,
                        simSlot = jobObj?.optInt("simSlot", simSlot ?: 1) ?: simSlot
                    )
                } else {
                    val errorCode = extractErrorCode(bodyStr) ?: "HTTP_${response.code}"
                    val retryable = response.code == 408 || response.code == 429 || response.code >= 500
                    OutboundSmsDispatchingResult(
                        accepted = false,
                        retryable = retryable,
                        errorCode = errorCode,
                        errorMessage = extractErrorMessage(bodyStr, "Dispatch intent rejected")
                    )
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "markOutboundSmsDispatching exception for $jobId: ${e.message}")
            OutboundSmsDispatchingResult(
                accepted = false,
                retryable = true,
                errorCode = "NETWORK_ERROR",
                errorMessage = e.message
            )
        }
    }

    /**
     * Reports cellular radio outcome (SUBMITTED, DELIVERED, FAILED, UNCERTAIN)
     * via POST /v1/messaging/device-jobs/:jobId/result.
     */
    suspend fun reportOutboundSmsJobResult(report: OutboundSmsJobResultReport): OutboundSmsJobResultAck {
        if (secureStorage.isRevoked) {
            return OutboundSmsJobResultAck(accepted = false, retryable = false, errorCode = "DEVICE_REVOKED")
        }
        val endpoint = "${getBaseUrl()}/v1/messaging/device-jobs/${report.jobId}/result"
        val bodyJson = JSONObject().apply {
            put("leaseToken", report.leaseToken)
            put("outcome", report.outcome)
            if (report.simSlot != null) put("simSlot", report.simSlot)
            if (report.partsCount != null) put("partsCount", report.partsCount)
            if (report.radioResultCode != null) put("radioResultCode", report.radioResultCode)
            if (!report.gatewayReference.isNullOrBlank()) put("gatewayReference", report.gatewayReference)
            if (!report.errorMessage.isNullOrBlank()) put("errorMessage", report.errorMessage)
            if (!report.failureCode.isNullOrBlank()) put("failureCode", report.failureCode)
            if (report.preRadioFailure) put("preRadioFailure", true)
            if (!report.carrierTimestamp.isNullOrBlank()) put("carrierTimestamp", report.carrierTimestamp)
        }

        val httpRequest = Request.Builder()
            .url(endpoint)
            .post(bodyJson.toString().toRequestBody(JSON_MEDIA_TYPE))
            .build()

        return try {
            okHttpClient.newCall(httpRequest).execute().use { response ->
                val bodyStr = response.body?.string() ?: ""
                if (response.isSuccessful) {
                    val root = if (bodyStr.isNotEmpty()) JSONObject(bodyStr) else JSONObject()
                    val dataObj = root.optJSONObject("data") ?: root
                    val jobObj = dataObj.optJSONObject("job")
                    OutboundSmsJobResultAck(
                        accepted = dataObj.optBoolean("accepted", true),
                        retryable = false,
                        idempotentReplay = dataObj.optBoolean("idempotentReplay", false),
                        serverStatus = jobObj?.optString("status", "")?.ifEmpty { null }
                    )
                } else {
                    val errorCode = extractErrorCode(bodyStr) ?: "HTTP_${response.code}"
                    val retryable = response.code == 408 || response.code == 429 || response.code >= 500
                    OutboundSmsJobResultAck(
                        accepted = false,
                        retryable = retryable,
                        errorCode = errorCode
                    )
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "reportOutboundSmsJobResult exception for ${report.jobId}: ${e.message}")
            OutboundSmsJobResultAck(accepted = false, retryable = true, errorCode = "NETWORK_ERROR")
        }
    }

    private fun extractErrorCode(bodyStr: String): String? {
        return try {
            val json = JSONObject(bodyStr)
            json.optJSONObject("error")?.optString("code")?.ifEmpty { null }
        } catch (_: Exception) {
            null
        }
    }

    private fun buildApiException(statusCode: Int, bodyStr: String, fallback: String): PairingApiException {
        return try {
            val json = JSONObject(bodyStr)
            val errObj = json.optJSONObject("error")
            val code = errObj?.optString("code")?.takeIf { it.isNotBlank() } ?: "HTTP_$statusCode"
            val msg = errObj?.optString("message")?.takeIf { it.isNotBlank() }
                ?: json.optString("message", fallback).takeIf { it.isNotBlank() }
                ?: fallback
            PairingApiException(statusCode, code, msg)
        } catch (e: Exception) {
            PairingApiException(statusCode, "HTTP_$statusCode", fallback)
        }
    }

    private fun extractErrorMessage(bodyStr: String, fallback: String): String {
        return try {
            val json = JSONObject(bodyStr)
            val errObj = json.optJSONObject("error")
            errObj?.optString("message") ?: json.optString("message", fallback)
        } catch (e: Exception) {
            fallback
        }
    }
}
