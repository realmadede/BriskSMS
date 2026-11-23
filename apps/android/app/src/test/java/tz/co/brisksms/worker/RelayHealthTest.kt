package tz.co.brisksms.worker

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RelayHealthTest {

    private fun check(
        isRevoked: Boolean = false,
        bulk: Boolean = true,
        simKnown: Boolean = true,
        sims: Int = 1,
        queued: Int = 0,
        stalled: Int = 0
    ) = RelayHealth.problems(isRevoked, bulk, simKnown, sims, queued, stalled)

    @Test
    fun healthyRelayHasNoProblems() {
        assertTrue(check().isEmpty())
    }

    @Test
    fun missingSimIsReportedOnlyWhenMessagingIsOnAndTheStateIsKnown() {
        assertEquals(1, check(sims = 0).size)
        assertTrue(check(sims = 0, bulk = false).isEmpty())
        assertTrue(check(sims = 0, simKnown = false).isEmpty())
    }

    @Test
    fun stuckMessagesAndStalledUploadsAreCountedInPlainWords() {
        assertEquals(listOf("1 message has been waiting for more than 30 minutes."), check(queued = 1))
        assertEquals(listOf("3 messages have been waiting for more than 30 minutes."), check(queued = 3))
        assertEquals(listOf("1 payment text has not reached your account for over an hour."), check(stalled = 1))
        assertEquals(2, check(queued = 2, stalled = 2).size)
    }

    @Test
    fun pausedMessagingDoesNotReportAQueueThatIsMeantToWait() {
        assertTrue(check(bulk = false, queued = 5).isEmpty())
        assertEquals(1, check(bulk = false, stalled = 5).size)
    }

    @Test
    fun aRevokedPhoneStaysQuiet() {
        assertTrue(check(isRevoked = true, sims = 0, queued = 4, stalled = 4).isEmpty())
    }
}
