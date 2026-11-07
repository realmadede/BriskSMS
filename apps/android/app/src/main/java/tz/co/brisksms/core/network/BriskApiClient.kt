package tz.co.brisksms.core.network

import android.os.Build
import android.util.Log
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject
import tz.co.brisksms.core.storage.KeystoreSecureStorage
import java.io.IOException
import java.util.concurrent.TimeUnit

data class PairDeviceRequest(
    val enrollmentToken: String,
    val label: String,
    val publicKeyPem: String,
    val deviceModel: String = Build.MODEL,
    val manufacturer: String = Build.MANUFACTURER,
    val androidVersion: String = Build.VERSION.RELEASE,
    val appVersion: String = "1.0.0",
    val ingestionMode: String = "NOTIFICATION_LISTENER"
)

data class PairDeviceResponse(
    val deviceId: String,
    val organizationId: String,
    val deviceToken: String,
    val syncIntervalSeconds: Int
)

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

data class DeviceTelemetryRequest(
    val batteryPercentage: Int,
    val isCharging: Boolean,
    val networkType: String,
    val signalStrengthDbm: Int? = null,
    val pendingOfflineCount: Int = 0
)

/**
 * Universal Secure Network Client for BriskSMS Android
 * Enforces TLS, device Bearer token authentication, timeout policies, and structured error responses.
 */
class BriskApiClient(private val secureStorage: KeystoreSecureStorage) {

    companion object {
        private const val TAG = "BriskApiClient"
        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
        private const val USER_AGENT = "BriskSMS-Android/1.0.0"
    }

    private val authInterceptor = Interceptor { chain ->
        val original = chain.request()
        val requestBuilder = original.newBuilder()
            .header("User-Agent", USER_AGENT)
            .header("Accept", "application/json")

        val token = secureStorage.deviceToken
        if (token != null && original.header("Authorization") == null) {
            requestBuilder.header("Authorization", "Bearer $token")
        }

        val response = chain.proceed(requestBuilder.build())

        // Handle device revocation globally
        if (response.code == 403) {
            try {
                val peekBody = response.peekBody(2048).string()
                if (peekBody.contains("DEVICE_REVOKED")) {
                    Log.w(TAG, "Device revocation detected from backend. Marking device revoked.")
                    secureStorage.isRevoked = true
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
     * Executes device pairing exchange (POST /v1/devices/pair)
     */
    suspend fun pairDevice(request: PairDeviceRequest): Result<PairDeviceResponse> {
        return try {
            val endpoint = "${getBaseUrl()}/v1/devices/pair"
            val bodyJson = JSONObject().apply {
                put("enrollmentToken", request.enrollmentToken)
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
                    val errMsg = extractErrorMessage(bodyStr, "Pairing failed with HTTP ${response.code}")
                    return Result.failure(IOException(errMsg))
                }

                val json = JSONObject(bodyStr)
                val data = json.getJSONObject("data")
                val result = PairDeviceResponse(
                    deviceId = data.getString("deviceId"),
                    organizationId = data.getString("organizationId"),
                    deviceToken = data.getString("deviceToken"),
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
                if (!response.isSuccessful && response.code != 409) {
                    val errMsg = extractErrorMessage(bodyStr, "Upload failed with HTTP ${response.code}")
                    return Result.failure(IOException(errMsg))
                }

                val json = JSONObject(bodyStr)
                val data = json.optJSONObject("data")
                val status = data?.optString("status") ?: if (response.code == 409) "DUPLICATE" else "OBSERVED"
                val evidenceId = data?.optString("evidenceId") ?: "ack_${System.currentTimeMillis()}"
                val hash = data?.optString("deduplicationHash")

                Result.success(
                    IngestionAckResponse(
                        acknowledged = true,
                        evidenceId = evidenceId,
                        deduplicationHash = hash,
                        status = status
                    )
                )
            }
        } catch (e: Exception) {
            Log.e(TAG, "Exception during evidence upload: ${e.message}")
            Result.failure(e)
        }
    }

    /**
     * Reports device operational health & telemetry (POST /v1/devices/:id/telemetry)
     */
    suspend fun sendTelemetry(telemetry: DeviceTelemetryRequest): Result<Boolean> {
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
            }

            val httpRequest = Request.Builder()
                .url(endpoint)
                .post(bodyJson.toString().toRequestBody(JSON_MEDIA_TYPE))
                .build()

            okHttpClient.newCall(httpRequest).execute().use { response ->
                if (response.isSuccessful) {
                    Result.success(true)
                } else {
                    Result.failure(IOException("Telemetry failed with HTTP ${response.code}"))
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Telemetry upload exception: ${e.message}")
            Result.failure(e)
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
