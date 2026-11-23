package tz.co.brisksms.service

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import tz.co.brisksms.core.storage.KeystoreSecureStorage
import tz.co.brisksms.payment.CaptureCounters
import tz.co.brisksms.payment.CaptureSource
import tz.co.brisksms.payment.NotificationText
import tz.co.brisksms.payment.NotificationTextExtractor
import tz.co.brisksms.payment.PaymentEvidenceRecorder
import tz.co.brisksms.payment.provider.PaymentProviderRegistry

/**
 * Purpose-Limited Notification Collector Service
 * Ingests financial notifications exclusively from authorized Tanzanian payment providers.
 * Strictly ignores personal communications, social apps, and unrelated system notifications.
 */
class BriskNotificationListenerService : NotificationListenerService() {

    companion object {
        private const val TAG = "BriskNotificationRelay"
    }

    private val serviceScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        super.onNotificationPosted(sbn)
        if (sbn == null) return

        val secureStorage = KeystoreSecureStorage(applicationContext)
        if (!secureStorage.isPaired || !secureStorage.isPaymentIntelligenceEnabled) {
            return
        }

        val packageName = sbn.packageName ?: return
        val extras = sbn.notification.extras ?: return

        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()?.trim() ?: ""
        val text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()?.trim() ?: ""
        val bigText = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString()?.trim() ?: ""
        val textLines = extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES)
            ?.map { it.toString() } ?: emptyList()
        val style = NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(sbn.notification)
        val messages = style?.messages?.map {
            NotificationText(it.person?.name?.toString().orEmpty(), it.text?.toString().orEmpty(), it.timestamp)
        } ?: emptyList()

        // Enforce purpose-limited notification scope: authorized financial apps or verified SMS shortcodes only.
        // Each text in the notification is judged on its own.
        NotificationTextExtractor
            .candidates(title, style?.conversationTitle?.toString(), text, bigText, textLines, messages)
            .onEach { countIfFromSupportedSender(packageName, it) }
            .filter { PaymentProviderRegistry.isEligibleNotificationSource(packageName, it.sender, it.body) }
            .forEach { payment ->
                Log.i(TAG, "Ingesting authorized payment notification from [$packageName]: ${payment.sender}")
                serviceScope.launch {
                    PaymentEvidenceRecorder.record(
                        applicationContext,
                        packageName,
                        payment.sender.ifEmpty { packageName },
                        payment.body,
                        payment.timestamp ?: sbn.postTime
                    )
                }
            }
    }

    // Counts what the filter did with texts under a supported sender name; other notifications are not counted
    private fun countIfFromSupportedSender(packageName: String, text: NotificationText) {
        if (PaymentProviderRegistry.isBlockedPersonalPackage(packageName)) return
        val verdict = PaymentProviderRegistry.classifyMessage(text.sender, text.body)
        if (verdict.senderIsSupported) {
            CaptureCounters.record(applicationContext, CaptureSource.NOTIFICATION, verdict)
        }
    }
}
