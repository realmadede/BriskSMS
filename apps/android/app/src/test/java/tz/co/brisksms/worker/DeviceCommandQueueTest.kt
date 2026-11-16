package tz.co.brisksms.worker

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import tz.co.brisksms.core.network.DeviceCommandAckOutcome
import tz.co.brisksms.core.network.DeviceCommandAckPayload
import tz.co.brisksms.core.network.DeviceCommandPayload

class DeviceCommandQueueTest {

    @Test
    fun allowedCommandTypes_matchExactEndToEndAllowlist() {
        assertEquals(
            setOf("PAUSE_RELAY", "RESUME_RELAY", "SWITCH_SIM", "WIPE_AND_REVOKE"),
            DeviceCommandProcessor.ALLOWED_COMMAND_TYPES
        )
        assertTrue(DeviceCommandProcessor.isSupportedCommandType("PAUSE_RELAY"))
        assertTrue(DeviceCommandProcessor.isSupportedCommandType("RESUME_RELAY"))
        assertTrue(DeviceCommandProcessor.isSupportedCommandType("SWITCH_SIM"))
        assertTrue(DeviceCommandProcessor.isSupportedCommandType("WIPE_AND_REVOKE"))

        assertFalse(DeviceCommandProcessor.isSupportedCommandType("PING"))
        assertFalse(DeviceCommandProcessor.isSupportedCommandType("SYNC"))
        assertFalse(DeviceCommandProcessor.isSupportedCommandType("RESTART_SERVICE"))
    }

    @Test
    fun switchSimValidation_acceptsOnlySlots1Or2() {
        assertEquals(1, DeviceCommandProcessor.parseValidatedSimSlot(1))
        assertEquals(2, DeviceCommandProcessor.parseValidatedSimSlot(2))
        assertEquals(2, DeviceCommandProcessor.parseValidatedSimSlot(2L))
        assertEquals(1, DeviceCommandProcessor.parseValidatedSimSlot(1.0))

        assertNull(DeviceCommandProcessor.parseValidatedSimSlot(null))
        assertNull(DeviceCommandProcessor.parseValidatedSimSlot(0))
        assertNull(DeviceCommandProcessor.parseValidatedSimSlot(3))
        assertNull(DeviceCommandProcessor.parseValidatedSimSlot(-1))
        assertNull(DeviceCommandProcessor.parseValidatedSimSlot(1.5))
        assertNull(DeviceCommandProcessor.parseValidatedSimSlot("2"))
    }

    @Test
    fun pendingAckReconciliation_skipsLocalReexecutionAndClearsResolvedItems() {
        val ack1 = DeviceCommandAckPayload(
            commandId = "11111111-1111-1111-1111-111111111111",
            status = "ACKNOWLEDGED",
            leaseToken = "22222222-2222-2222-2222-222222222222"
        )
        val ack2 = DeviceCommandAckPayload(
            commandId = "33333333-3333-3333-3333-333333333333",
            status = "FAILED",
            failureReason = "Invalid slot"
        )

        var pending = DeviceCommandProcessor.mergePendingAck(emptyList(), ack1)
        pending = DeviceCommandProcessor.mergePendingAck(pending, ack2)
        assertEquals(2, pending.size)

        val redeliveredCmd1 = DeviceCommandPayload(
            id = ack1.commandId,
            type = "PAUSE_RELAY",
            leaseToken = "44444444-4444-4444-4444-444444444444"
        )
        val newCmd3 = DeviceCommandPayload(
            id = "55555555-5555-5555-5555-555555555555",
            type = "RESUME_RELAY"
        )

        assertTrue(DeviceCommandProcessor.shouldSkipAlreadyPendingAck(redeliveredCmd1, pending))
        assertFalse(DeviceCommandProcessor.shouldSkipAlreadyPendingAck(newCmd3, pending))

        val reconciled = DeviceCommandProcessor.reconcilePendingAcks(
            pending,
            listOf(
                DeviceCommandAckOutcome(commandId = ack1.commandId, accepted = true, status = "ACKNOWLEDGED"),
                DeviceCommandAckOutcome(commandId = ack2.commandId, accepted = false, errorCode = "COMMAND_EXPIRED")
            )
        )
        assertTrue(reconciled.isEmpty())
    }
}
