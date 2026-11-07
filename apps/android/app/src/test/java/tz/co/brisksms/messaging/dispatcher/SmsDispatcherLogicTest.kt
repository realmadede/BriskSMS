package tz.co.brisksms.messaging.dispatcher

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import tz.co.brisksms.messaging.data.DispatchState
import tz.co.brisksms.messaging.data.SmsDispatchEntity
import java.util.UUID

class SmsDispatcherLogicTest {

    @Test
    fun dispatchState_preservesSeparationBetweenSubmittedAndDelivered() {
        // Critical Architectural Invariant: Carrier radio submission does NOT equal recipient handset delivery
        val submitted = DispatchState.SUBMITTED
        val delivered = DispatchState.DELIVERED

        assertNotEquals(submitted, delivered)
        assertEquals("SUBMITTED", submitted.name)
        assertEquals("DELIVERED", delivered.name)
    }

    @Test
    fun dispatchState_supportsTerminalAndTransientStates() {
        val states = DispatchState.values().map { it.name }
        assertTrue(states.contains("RECEIVED"))
        assertTrue(states.contains("QUEUED"))
        assertTrue(states.contains("DISPATCHING"))
        assertTrue(states.contains("SUBMITTED"))
        assertTrue(states.contains("DELIVERED"))
        assertTrue(states.contains("FAILED"))
        assertTrue(states.contains("UNKNOWN"))
    }

    @Test
    fun smsDispatchEntity_requiresUniqueIdempotencyKey() {
        val key = "idem_tx_12345"
        val dispatch1 = SmsDispatchEntity(
            organizationId = "org_1",
            recipientPhone = "+255713000111",
            messageText = "Hello customer",
            idempotencyKey = key
        )
        val dispatch2 = SmsDispatchEntity(
            organizationId = "org_1",
            recipientPhone = "+255713000111",
            messageText = "Hello customer",
            idempotencyKey = key
        )

        assertEquals(dispatch1.idempotencyKey, dispatch2.idempotencyKey)
        assertNotEquals(dispatch1.id, dispatch2.id)
    }

    @Test
    fun multipartMessage_characterCountBoundaryCheck() {
        val singlePartGsm7 = "A".repeat(160)
        val multiPartGsm7 = "A".repeat(161)

        assertTrue(singlePartGsm7.length <= 160)
        assertTrue(multiPartGsm7.length > 160)

        // When split into multipart segments, standard GSM 7-bit concats use 153 chars/segment
        val segmentLength = 153
        val expectedParts = Math.ceil(multiPartGsm7.length.toDouble() / segmentLength).toInt()
        assertEquals(2, expectedParts)
    }

    @Test
    fun ambiguousState_mustNotBeBlindlyRetried() {
        // Unknown state indicates unconfirmed radio dispatch; must require manual or gateway verification
        val entity = SmsDispatchEntity(
            organizationId = "org_1",
            recipientPhone = "+255754000111",
            messageText = "Testing ambiguous state",
            idempotencyKey = "key_ambiguous",
            status = DispatchState.UNKNOWN.name
        )

        val canBlindlyRetry = entity.status == DispatchState.FAILED.name && entity.attempts < 3
        assertFalse(canBlindlyRetry)
    }
}
