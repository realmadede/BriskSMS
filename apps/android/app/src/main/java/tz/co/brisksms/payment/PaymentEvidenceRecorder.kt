package tz.co.brisksms.payment

import android.content.Context
import android.util.Log
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import tz.co.brisksms.core.storage.KeystoreSecureStorage
import tz.co.brisksms.data.local.BriskDatabase
import tz.co.brisksms.data.local.OfflineEvidenceEntity
import tz.co.brisksms.payment.crypto.EvidenceEncryptor
import tz.co.brisksms.security.KeystoreManager
import tz.co.brisksms.worker.EvidenceUploadWorker

/**
 * Stores one already-filtered payment message as signed, encrypted offline evidence and schedules its upload.
 * Callers (the notification listener and the SMS receiver) must apply PaymentProviderRegistry first.
 */
object PaymentEvidenceRecorder {

    private const val TAG = "PaymentEvidenceRecorder"

    suspend fun record(
        context: Context,
        sourceId: String,
        sender: String,
        rawPayload: String,
        deviceTimestamp: Long
    ) {
        val appContext = context.applicationContext

        // Digital cryptographic signature using device key
        val signature = try {
            KeystoreManager().sign(rawPayload.toByteArray(Charsets.UTF_8))
        } catch (e: Exception) {
            Log.w(TAG, "Device signing failed, proceeding with raw payload: ${e.message}")
            null
        }

        val encryptedPayload = EvidenceEncryptor(KeystoreSecureStorage(appContext)).encryptPayload(rawPayload)

        BriskDatabase.getInstance(appContext).evidenceDao().insertEvidence(
            OfflineEvidenceEntity(
                packageName = sourceId,
                senderAddress = sender,
                rawPayload = encryptedPayload,
                deviceTimestamp = deviceTimestamp,
                signature = signature
            )
        )

        // Trigger WorkManager reliable background forwarding
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()
        WorkManager.getInstance(appContext).enqueueUniqueWork(
            "BrisksmsEvidenceUpload",
            ExistingWorkPolicy.APPEND_OR_REPLACE,
            OneTimeWorkRequestBuilder<EvidenceUploadWorker>().setConstraints(constraints).build()
        )
    }
}
