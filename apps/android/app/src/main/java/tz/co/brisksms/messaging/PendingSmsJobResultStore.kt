package tz.co.brisksms.messaging

import android.util.Log
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONArray
import org.json.JSONObject
import tz.co.brisksms.core.network.BriskApiClient
import tz.co.brisksms.core.storage.KeystoreSecureStorage

/**
 * Thread-safe, Keystore AES-256-GCM persisted queue for outbound SMS job result reports.
 * Ensures SUBMITTED / DELIVERED / FAILED / UNCERTAIN cellular outcomes survive process death
 * and network drops without ever re-invoking SmsManager.
 */
object PendingSmsJobResultStore {

    private const val TAG = "PendingSmsResultStore"
    private val storeMutex = Mutex()

    fun loadLocked(secureStorage: KeystoreSecureStorage): List<OutboundSmsJobResultReport> {
        val raw = secureStorage.pendingSmsJobResultsJson ?: return emptyList()
        return try {
            val arr = JSONArray(raw)
            val list = mutableListOf<OutboundSmsJobResultReport>()
            for (i in 0 until arr.length()) {
                val obj = arr.getJSONObject(i)
                val jobId = obj.optString("jobId", "")
                val leaseToken = obj.optString("leaseToken", "")
                val outcome = obj.optString("outcome", "")
                if (jobId.isNotBlank() && leaseToken.isNotBlank() && OutboundSmsJobCoordinator.VALID_OUTCOMES.contains(outcome)) {
                    list.add(
                        OutboundSmsJobResultReport(
                            jobId = jobId,
                            leaseToken = leaseToken,
                            outcome = outcome,
                            simSlot = if (obj.has("simSlot") && !obj.isNull("simSlot")) obj.getInt("simSlot") else null,
                            partsCount = if (obj.has("partsCount") && !obj.isNull("partsCount")) obj.getInt("partsCount") else null,
                            radioResultCode = if (obj.has("radioResultCode") && !obj.isNull("radioResultCode")) obj.getInt("radioResultCode") else null,
                            gatewayReference = if (obj.isNull("gatewayReference")) null else obj.optString("gatewayReference", "").ifEmpty { null },
                            errorMessage = if (obj.isNull("errorMessage")) null else obj.optString("errorMessage", "").ifEmpty { null },
                            failureCode = if (obj.isNull("failureCode")) null else obj.optString("failureCode", "").ifEmpty { null },
                            preRadioFailure = obj.optBoolean("preRadioFailure", false),
                            carrierTimestamp = if (obj.isNull("carrierTimestamp")) null else obj.optString("carrierTimestamp", "").ifEmpty { null }
                        )
                    )
                }
            }
            list
        } catch (e: Exception) {
            Log.w(TAG, "Failed decoding persisted SMS job results: ${e.message}")
            emptyList()
        }
    }

    fun saveLocked(secureStorage: KeystoreSecureStorage, items: List<OutboundSmsJobResultReport>) {
        if (items.isEmpty()) {
            secureStorage.pendingSmsJobResultsJson = null
            return
        }
        val arr = JSONArray()
        for (item in items) {
            arr.put(
                JSONObject().apply {
                    put("jobId", item.jobId)
                    put("leaseToken", item.leaseToken)
                    put("outcome", item.outcome)
                    if (item.simSlot != null) put("simSlot", item.simSlot)
                    if (item.partsCount != null) put("partsCount", item.partsCount)
                    if (item.radioResultCode != null) put("radioResultCode", item.radioResultCode)
                    if (!item.gatewayReference.isNullOrBlank()) put("gatewayReference", item.gatewayReference)
                    if (!item.errorMessage.isNullOrBlank()) put("errorMessage", item.errorMessage)
                    if (!item.failureCode.isNullOrBlank()) put("failureCode", item.failureCode)
                    if (item.preRadioFailure) put("preRadioFailure", true)
                    if (!item.carrierTimestamp.isNullOrBlank()) put("carrierTimestamp", item.carrierTimestamp)
                }
            )
        }
        secureStorage.pendingSmsJobResultsJson = arr.toString()
    }

    suspend fun snapshot(secureStorage: KeystoreSecureStorage): List<OutboundSmsJobResultReport> {
        return storeMutex.withLock {
            loadLocked(secureStorage)
        }
    }

    suspend fun submitOrPersist(
        secureStorage: KeystoreSecureStorage,
        apiClient: BriskApiClient,
        report: OutboundSmsJobResultReport
    ) {
        if (secureStorage.isRevoked) return

        // Persist first so process death during network call never loses a cellular outcome.
        storeMutex.withLock {
            val merged = OutboundSmsJobCoordinator.mergePendingReport(loadLocked(secureStorage), report)
            saveLocked(secureStorage, merged)
        }

        val ack = apiClient.reportOutboundSmsJobResult(report)
        if (ack.accepted || !ack.retryable) {
            storeMutex.withLock {
                val updated = OutboundSmsJobCoordinator.removePendingReport(
                    loadLocked(secureStorage),
                    report.jobId,
                    report.outcome
                )
                saveLocked(secureStorage, updated)
            }
            if (!ack.accepted) {
                Log.w(TAG, "Server permanently rejected SMS result [${report.jobId}/${report.outcome}]: ${ack.errorCode}")
            }
        }
    }

    suspend fun flushPending(
        secureStorage: KeystoreSecureStorage,
        apiClient: BriskApiClient
    ) {
        if (!secureStorage.isPaired || secureStorage.isRevoked) return

        val pending = storeMutex.withLock { loadLocked(secureStorage) }
        if (pending.isEmpty()) return

        for (report in pending) {
            if (secureStorage.isRevoked) break
            val ack = apiClient.reportOutboundSmsJobResult(report)
            if (ack.accepted || !ack.retryable) {
                storeMutex.withLock {
                    val remaining = OutboundSmsJobCoordinator.removePendingReport(
                        loadLocked(secureStorage),
                        report.jobId,
                        report.outcome
                    )
                    saveLocked(secureStorage, remaining)
                }
            }
        }
    }
}
