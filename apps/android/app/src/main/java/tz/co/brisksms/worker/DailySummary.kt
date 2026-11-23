package tz.co.brisksms.worker

import java.time.Duration
import java.time.ZonedDateTime

/** The wording and timing of the optional end-of-day notification. Counts only, never message text. */
object DailySummary {
    const val SEND_HOUR = 18

    fun lines(captured: Int, uploaded: Int, sent: Int, delivered: Int): List<String> {
        val lines = mutableListOf<String>()
        if (captured > 0) {
            lines += "$captured payment ${if (captured == 1) "text" else "texts"} captured, $uploaded sent to your account."
        }
        if (sent > 0) {
            lines += "$sent ${if (sent == 1) "message" else "messages"} sent, $delivered delivered."
        }
        return lines
    }

    /** Time from now until the next 18:00 on the phone's clock. */
    fun delayUntilNext(now: ZonedDateTime): Duration {
        var next = now.withHour(SEND_HOUR).withMinute(0).withSecond(0).withNano(0)
        if (!next.isAfter(now)) next = next.plusDays(1)
        return Duration.between(now, next)
    }
}
