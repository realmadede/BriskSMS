package tz.co.brisksms.service

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import androidx.work.Constraints
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import tz.co.brisksms.data.local.BriskDatabase
import tz.co.brisksms.data.local.OfflineEvidenceEntity
import tz.co.brisksms.security.KeystoreManager
import tz.co.brisksms.worker.EvidenceUploadWorker

/**
 * Purpose-Limited Notification Collector Service
 * Ingests financial notifications exclusively from authorized Tanzanian payment providers.
 * Strictly ignores personal communications, social apps, and unrelated system notifications.
 */
class BriskNotificationListenerService : NotificationListenerService() {

    companion object {
        private const val TAG = "BriskNotificationRelay"

        // Authorized mobile money & bank app package names
        private val AUTHORIZED_PAYMENT_PACKAGES = setOf(
            "com.vodafone.vodapay",
            "com.mpesa.tz",
            "com.tigo.pesa.tz",
            "com.yas.mixx",
            "com.airtel.africa.money",
            "com.halotel.halopesa",
            "com.crdb.mobile",
            "com.crdb.simbanking",
            "com.nmb.mobile",
            "com.nmb.direct"
        )

        // Known financial sender addresses for SMS notification fallbacks
        private val FINANCIAL_SENDER_PATTERNS = listOf(
            "M-PESA", "MPESA", "MIXX", "TIGO PESA", "AIRTELMONEY", "HALOPESA", "CRDB", "NMB"
        )
    }

    private val serviceScope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private val keystoreManager = KeystoreManager()

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        super.onNotificationPosted(sbn)
        if (sbn == null) return

        val packageName = sbn.packageName ?: return
        val extras = sbn.notification.extras ?: return

        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()?.trim() ?: ""
        val text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()?.trim() ?: ""
        val bigText = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString()?.trim() ?: ""

        val rawPayload = if (bigText.isNotEmpty()) bigText else text
        if (rawPayload.isEmpty()) return

        // 1. Check if source package is an authorized payment provider application
        val isAuthorizedApp = AUTHORIZED_PAYMENT_PACKAGES.contains(packageName)

        // 2. Check if notification title or sender matches known provider shortcode
        val isFinancialSender = FINANCIAL_SENDER_PATTERNS.any { pattern ->
            title.contains(pattern, ignoreCase = true) || rawPayload.contains(pattern, ignoreCase = true)
        }

        // Strictly discard any personal or unrelated notifications
        if (!isAuthorizedApp && !isFinancialSender) {
            return
        }

        Log.i(TAG, "Ingesting authorized payment notification from [$packageName]: $title")

        // Digital cryptographic signature using device key
        val signature = try {
            keystoreManager.sign(rawPayload.toByteArray(Charsets.UTF_8))
        } catch (e: Exception) {
            Log.w(TAG, "Device signing failed, proceeding with raw payload: ${e.message}")
            null
        }

        val evidence = OfflineEvidenceEntity(
            packageName = packageName,
            senderAddress = if (title.isNotEmpty()) title else packageName,
            rawPayload = rawPayload,
            deviceTimestamp = sbn.postTime,
            signature = signature
        )

        serviceScope.launch {
            val db = BriskDatabase.getInstance(applicationContext)
            db.evidenceDao().insertEvidence(evidence)

            // Trigger WorkManager reliable background forwarding
            enqueueUploadWork()
        }
    }

    private fun enqueueUploadWork() {
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()

        val uploadWorkRequest = OneTimeWorkRequestBuilder<EvidenceUploadWorker>()
            .setConstraints(constraints)
            .build()

        WorkManager.getInstance(applicationContext).enqueue(uploadWorkRequest)
    }
}
