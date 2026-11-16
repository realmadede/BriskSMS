package tz.co.brisksms.worker

import android.content.Context
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import tz.co.brisksms.core.network.BriskApiClient
import tz.co.brisksms.core.network.EvidenceUploadException
import tz.co.brisksms.core.network.IngestionEvidenceRequest
import tz.co.brisksms.core.storage.KeystoreSecureStorage
import tz.co.brisksms.data.local.BriskDatabase
import tz.co.brisksms.data.local.OfflineEvidenceEntity
import tz.co.brisksms.payment.crypto.EvidenceEncryptor
import tz.co.brisksms.security.KeystoreManager

sealed class SingleUploadOutcome {
    object Uploaded : SingleUploadOutcome()
    data class RetryableFailure(val reason: String) : SingleUploadOutcome()
    data class PermanentFailure(val reason: String) : SingleUploadOutcome()
}

/**
 * Reliable Background Evidence Forwarding Worker
 * Employs WorkManager exponential backoff, device Bearer authentication, and dynamic backend URLs.
 * CRITICAL FINANCIAL INVARIANT: Uploads evidence for observation only. Never confirms settlement or verification.
 */
class EvidenceUploadWorker(
    appContext: Context,
    workerParams: WorkerParameters
) : CoroutineWorker(appContext, workerParams) {

    companion object {
        private const val TAG = "EvidenceUploadWorker"
        const val MAX_RETRIES = 5
    }

    private val secureStorage = KeystoreSecureStorage(applicationContext)
    private val apiClient = BriskApiClient(secureStorage)
    private val encryptor = EvidenceEncryptor(secureStorage)

    override suspend fun doWork(): Result {
        val db = BriskDatabase.getInstance(applicationContext)
        if (!secureStorage.isPaired || secureStorage.isRevoked) {
            Log.w(TAG, "Device is not paired or has been revoked. Skipping evidence upload.")
            if (secureStorage.isRevoked) {
                withContext(Dispatchers.IO) { db.clearAllTables() }
                runCatching { KeystoreManager().deleteKey() }
            }
            return Result.failure()
        }

        val dao = db.evidenceDao()

        val pendingList = dao.getPendingEvidence(limit = 25)
        if (pendingList.isEmpty()) {
            return Result.success()
        }

        var anyRetryableFailed = false

        for (evidence in pendingList) {
            if (evidence.retryCount >= MAX_RETRIES) {
                Log.w(TAG, "Evidence [${evidence.id}] exceeded max retries ($MAX_RETRIES). Marking permanent failure.")
                dao.markPermanentFailure(evidence.id, "MAX_RETRIES_EXCEEDED")
                continue
            }

            when (val outcome = uploadSingleEvidence(evidence)) {
                is SingleUploadOutcome.Uploaded -> dao.markUploaded(evidence.id)
                is SingleUploadOutcome.PermanentFailure -> {
                    Log.w(TAG, "Permanent failure for evidence [${evidence.id}]: ${outcome.reason}")
                    dao.markPermanentFailure(evidence.id, outcome.reason.take(250))
                    if (secureStorage.isRevoked) {
                        withContext(Dispatchers.IO) { db.clearAllTables() }
                        runCatching { KeystoreManager().deleteKey() }
                        return Result.failure()
                    }
                }
                is SingleUploadOutcome.RetryableFailure -> {
                    dao.incrementRetryCount(evidence.id, outcome.reason.take(250))
                    if (secureStorage.isRevoked) {
                        withContext(Dispatchers.IO) { db.clearAllTables() }
                        runCatching { KeystoreManager().deleteKey() }
                        return Result.failure()
                    }
                    anyRetryableFailed = true
                }
            }
        }

        return if (anyRetryableFailed) Result.retry() else Result.success()
    }

    private suspend fun uploadSingleEvidence(evidence: OfflineEvidenceEntity): SingleUploadOutcome {
        return try {
            // Decrypt local payload in memory immediately before network dispatch
            val plaintextPayload = encryptor.decryptPayload(evidence.rawPayload)
            if (plaintextPayload.contains("[CORRUPTED_OR_TAMPERED_PAYLOAD]")) {
                Log.e(TAG, "Integrity failure: Evidence [${evidence.id}] was corrupted or tampered.")
                return SingleUploadOutcome.PermanentFailure("CORRUPTED_OR_TAMPERED_PAYLOAD")
            }

            val request = IngestionEvidenceRequest(
                senderAddress = evidence.senderAddress,
                rawPayload = plaintextPayload,
                simSlot = evidence.simSlot,
                deviceTimestamp = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US).apply {
                    timeZone = java.util.TimeZone.getTimeZone("UTC")
                }.format(java.util.Date(evidence.deviceTimestamp)),
                signature = evidence.signature
            )

            val result = apiClient.uploadEvidence(request)
            if (result.isSuccess) {
                SingleUploadOutcome.Uploaded
            } else {
                val err = result.exceptionOrNull()
                if (err is EvidenceUploadException && err.permanentFailure) {
                    SingleUploadOutcome.PermanentFailure("${err.errorCode}: ${err.message}")
                } else {
                    SingleUploadOutcome.RetryableFailure(err?.message ?: "Upload failed")
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Exception uploading evidence [${evidence.id}]: ${e.message}")
            SingleUploadOutcome.RetryableFailure(e.message ?: "Upload exception")
        }
    }
}
