package tz.co.brisksms.worker

import android.content.Context
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import tz.co.brisksms.core.network.BriskApiClient
import tz.co.brisksms.core.network.IngestionEvidenceRequest
import tz.co.brisksms.core.storage.KeystoreSecureStorage
import tz.co.brisksms.data.local.BriskDatabase
import tz.co.brisksms.data.local.OfflineEvidenceEntity
import tz.co.brisksms.payment.crypto.EvidenceEncryptor

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
        private const val MAX_RETRIES = 5
    }

    private val secureStorage = KeystoreSecureStorage(applicationContext)
    private val apiClient = BriskApiClient(secureStorage)
    private val encryptor = EvidenceEncryptor(secureStorage)

    override suspend fun doWork(): Result {
        if (!secureStorage.isPaired || secureStorage.isRevoked) {
            Log.w(TAG, "Device is not paired or has been revoked. Skipping evidence upload.")
            return Result.failure()
        }

        val db = BriskDatabase.getInstance(applicationContext)
        val dao = db.evidenceDao()

        val pendingList = dao.getPendingEvidence(limit = 25)
        if (pendingList.isEmpty()) {
            return Result.success()
        }

        var anyFailed = false

        for (evidence in pendingList) {
            // Abandon after max retries to prevent unbounded queue growth
            if (evidence.retryCount >= MAX_RETRIES) {
                Log.w(TAG, "Evidence [${evidence.id}] exceeded max retries. Marking failed.")
                dao.markUploaded(evidence.id) // Archive/remove from pending queue
                continue
            }

            val uploaded = uploadSingleEvidence(evidence)
            if (uploaded) {
                dao.markUploaded(evidence.id)
            } else {
                dao.incrementRetryCount(evidence.id)
                anyFailed = true
            }
        }

        return if (anyFailed) Result.retry() else Result.success()
    }

    private suspend fun uploadSingleEvidence(evidence: OfflineEvidenceEntity): Boolean {
        return try {
            // Decrypt local payload in memory immediately before network dispatch
            val plaintextPayload = encryptor.decryptPayload(evidence.rawPayload)
            if (plaintextPayload.contains("[CORRUPTED_OR_TAMPERED_PAYLOAD]")) {
                Log.e(TAG, "Integrity failure: Evidence [${evidence.id}] was corrupted or tampered.")
                return false
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
            result.isSuccess
        } catch (e: Exception) {
            Log.e(TAG, "Exception uploading evidence [${evidence.id}]: ${e.message}")
            false
        }
    }
}
