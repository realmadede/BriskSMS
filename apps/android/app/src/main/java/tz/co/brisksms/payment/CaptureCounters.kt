package tz.co.brisksms.payment

import android.content.Context
import tz.co.brisksms.payment.provider.MessageVerdict

enum class CaptureSource { SMS, NOTIFICATION }

data class CaptureStats(
    val kept: Int,
    val notAPayment: Int,
    val outgoingMoney: Int,
    val personalNumber: Int,
    val otherSender: Int,
    val lastKeptAt: Long?
)

/**
 * Counts how many texts were kept or dropped and why, so a real-phone test shows what the filter did.
 * Only counts are stored, never message text or senders. A notification that is updated can be counted twice.
 */
object CaptureCounters {

    private const val PREFS = "brisksms_capture_counters"

    @Synchronized
    fun record(context: Context, source: CaptureSource, verdict: MessageVerdict) {
        val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val key = "${source.name}_${verdict.name}"
        prefs.edit().apply {
            putInt(key, prefs.getInt(key, 0) + 1)
            if (verdict == MessageVerdict.KEPT) putLong("${source.name}_LAST_KEPT", System.currentTimeMillis())
        }.apply()
    }

    fun stats(context: Context, source: CaptureSource): CaptureStats {
        val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        fun count(verdict: MessageVerdict) = prefs.getInt("${source.name}_${verdict.name}", 0)
        return CaptureStats(
            kept = count(MessageVerdict.KEPT),
            notAPayment = count(MessageVerdict.NOT_A_PAYMENT),
            outgoingMoney = count(MessageVerdict.OUTGOING_MONEY),
            personalNumber = count(MessageVerdict.PERSONAL_NUMBER),
            otherSender = count(MessageVerdict.OTHER_SENDER),
            lastKeptAt = prefs.getLong("${source.name}_LAST_KEPT", 0L).takeIf { it > 0L }
        )
    }
}
