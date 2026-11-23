package tz.co.brisksms.payment.sms

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import tz.co.brisksms.core.storage.KeystoreSecureStorage
import tz.co.brisksms.payment.CaptureCounters
import tz.co.brisksms.payment.CaptureSource
import tz.co.brisksms.payment.PaymentEvidenceRecorder
import tz.co.brisksms.payment.provider.MessageVerdict
import tz.co.brisksms.payment.provider.PaymentProviderRegistry

/**
 * Direct-download build only. Receives incoming SMS and keeps a message only when its sender is a
 * supported mobile money or bank shortcode and its text is an incoming credit. Every other message,
 * including any from a personal phone number, is dropped here without being stored or logged.
 */
class PaymentSmsReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return

        val secureStorage = KeystoreSecureStorage(context.applicationContext)
        if (!secureStorage.isPaired || !secureStorage.isPaymentIntelligenceEnabled) return

        // A long SMS arrives in parts from the same sender; join them before judging the text
        val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
        val payments = messages
            .filter { it.originatingAddress != null }
            .groupBy { it.originatingAddress!! }
            .map { (sender, parts) ->
                Triple(sender, parts.joinToString("") { it.messageBody.orEmpty() }.trim(), parts.first().timestampMillis)
            }
            .filter { (sender, body, _) ->
                val verdict = PaymentProviderRegistry.classifyMessage(sender, body)
                CaptureCounters.record(context, CaptureSource.SMS, verdict)
                verdict == MessageVerdict.KEPT
            }
        if (payments.isEmpty()) return

        val pending = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try {
                payments.forEach { (sender, body, timestamp) ->
                    Log.i("PaymentSmsReceiver", "Ingesting authorized payment SMS from [$sender]")
                    PaymentEvidenceRecorder.record(context, "sms", sender, body, timestamp)
                }
            } finally {
                pending.finish()
            }
        }
    }
}
