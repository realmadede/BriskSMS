package tz.co.brisksms.worker

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId
import java.time.ZonedDateTime

class DailySummaryTest {

    private val dar = ZoneId.of("Africa/Dar_es_Salaam")

    @Test
    fun aQuietDayHasNothingToSay() {
        assertTrue(DailySummary.lines(0, 0, 0, 0).isEmpty())
    }

    @Test
    fun countsAreWordedForOneAndForMany() {
        assertEquals(
            listOf("1 payment text captured, 1 sent to your account.", "1 message sent, 0 delivered."),
            DailySummary.lines(1, 1, 1, 0)
        )
        assertEquals(
            listOf("12 payment texts captured, 11 sent to your account.", "40 messages sent, 38 delivered."),
            DailySummary.lines(12, 11, 40, 38)
        )
    }

    @Test
    fun onlyTheProductThatWasUsedIsMentioned() {
        assertEquals(listOf("3 payment texts captured, 3 sent to your account."), DailySummary.lines(3, 3, 0, 0))
        assertEquals(listOf("5 messages sent, 5 delivered."), DailySummary.lines(0, 0, 5, 5))
    }

    @Test
    fun nextSummaryIsTheNextSixInTheEvening() {
        val morning = ZonedDateTime.of(2026, 11, 23, 9, 30, 0, 0, dar)
        assertEquals(8 * 60 + 30L, DailySummary.delayUntilNext(morning).toMinutes())

        val afterSix = ZonedDateTime.of(2026, 11, 23, 19, 0, 0, 0, dar)
        assertEquals(23 * 60L, DailySummary.delayUntilNext(afterSix).toMinutes())

        val exactlySix = ZonedDateTime.of(2026, 11, 23, 18, 0, 0, 0, dar)
        assertEquals(24 * 60L, DailySummary.delayUntilNext(exactlySix).toMinutes())
    }
}
