package tz.co.brisksms.messaging

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import tz.co.brisksms.messaging.data.DispatchState

class OutboundSmsJobCoordinatorTest {

    private fun sampleJob(
        id: String = "job-1",
        leaseToken: String = "lease-abc",
        recipientPhone: String = "+255754000111",
        messageText: String = "Your invoice #104 is due.",
        simSlot: Int = 1
    ) = OutboundSmsJobPayload(
        id = id,
        organizationId = "org-1",
        messageId = "msg-1",
        recipientPhone = recipientPhone,
        messageText = messageText,
        simSlot = simSlot,
        leaseToken = leaseToken,
        idempotencyKey = "idem-1"
    )

    @Test
    fun validateAcquiredJob_rejectsInvalidFieldsFailClosed() {
        assertTrue(OutboundSmsJobCoordinator.validateAcquiredJob(sampleJob()) is JobValidationResult.Valid)
        assertTrue(OutboundSmsJobCoordinator.validateAcquiredJob(sampleJob(id = "")) is JobValidationResult.Invalid)
        assertTrue(OutboundSmsJobCoordinator.validateAcquiredJob(sampleJob(leaseToken = " ")) is JobValidationResult.Invalid)
        assertTrue(OutboundSmsJobCoordinator.validateAcquiredJob(sampleJob(recipientPhone = "0754000111")) is JobValidationResult.Invalid)
        assertTrue(OutboundSmsJobCoordinator.validateAcquiredJob(sampleJob(messageText = "")) is JobValidationResult.Invalid)
        assertTrue(OutboundSmsJobCoordinator.validateAcquiredJob(sampleJob(simSlot = 3)) is JobValidationResult.Invalid)
    }

    @Test
    fun selectDispatchSimSlot_usesDeviceCapabilityAndDailyCapWithoutRecipientPrefixInference() {
        val activeOnlySim2 = listOf(
            SimSlotCapability(simNumber = 1, isReady = false, sentTodayCount = 0),
            SimSlotCapability(simNumber = 2, isReady = true, sentTodayCount = 10)
        )
        val selected = OutboundSmsJobCoordinator.selectDispatchSimSlot(
            requestedSlot = 1,
            preferredDeviceSlot = 1,
            activeSlots = activeOnlySim2,
            dailyCapPerSim = 400
        )
        assertEquals(SimSelectionOutcome.Selected(2), selected)

        val cappedSim1 = listOf(
            SimSlotCapability(simNumber = 1, isReady = true, sentTodayCount = 400),
            SimSlotCapability(simNumber = 2, isReady = true, sentTodayCount = 399)
        )
        val failoverSelected = OutboundSmsJobCoordinator.selectDispatchSimSlot(
            requestedSlot = 1,
            preferredDeviceSlot = 1,
            activeSlots = cappedSim1,
            dailyCapPerSim = 400
        )
        assertEquals(SimSelectionOutcome.Selected(2), failoverSelected)

        val allCapped = listOf(
            SimSlotCapability(simNumber = 1, isReady = true, sentTodayCount = 400),
            SimSlotCapability(simNumber = 2, isReady = true, sentTodayCount = 400)
        )
        val capError = OutboundSmsJobCoordinator.selectDispatchSimSlot(
            requestedSlot = 1,
            preferredDeviceSlot = 1,
            activeSlots = allCapped,
            dailyCapPerSim = 400
        )
        assertTrue(capError is SimSelectionOutcome.Unavailable)
        assertEquals("SIM_DAILY_CAP_REACHED", (capError as SimSelectionOutcome.Unavailable).failureCode)

        val noSimError = OutboundSmsJobCoordinator.selectDispatchSimSlot(
            requestedSlot = 1,
            preferredDeviceSlot = 1,
            activeSlots = emptyList(),
            dailyCapPerSim = 400
        )
        assertEquals(
            SimSelectionOutcome.Unavailable("NO_ACTIVE_SIM", "No active ready SIM slots detected on companion device"),
            noSimError
        )
    }

    @Test
    fun shouldSkipAcquiredJob_blocksDuplicateDispatchWhenAlreadyInFlightOrCompletedOrPendingReport() {
        val job = sampleJob()
        for (state in listOf(DispatchState.DISPATCHING, DispatchState.SUBMITTED, DispatchState.DELIVERED, DispatchState.UNKNOWN)) {
            val localEntity = OutboundSmsJobCoordinator.toLocalDispatchEntity(job, 1).copy(status = state.name)
            assertTrue(
                "Expected skip for state $state",
                OutboundSmsJobCoordinator.shouldSkipAcquiredJob(job, localEntity, null, emptyList())
            )
        }

        val queuedEntity = OutboundSmsJobCoordinator.toLocalDispatchEntity(job, 1).copy(status = DispatchState.QUEUED.name)
        assertFalse(OutboundSmsJobCoordinator.shouldSkipAcquiredJob(job, queuedEntity, null, emptyList()))

        val pendingReport = OutboundSmsJobCoordinator.buildSubmittedReport(job.id, job.leaseToken, 1)
        assertTrue(OutboundSmsJobCoordinator.shouldSkipAcquiredJob(job, null, null, listOf(pendingReport)))
    }

    @Test
    fun canInvokeSmsManager_requiresServerDispatchingAcceptanceAndActiveRelay() {
        assertTrue(
            OutboundSmsJobCoordinator.canInvokeSmsManager(
                OutboundSmsDispatchingResult(accepted = true, retryable = false, simSlot = 1),
                relayEnabled = true,
                deviceRevoked = false
            )
        )
        assertFalse(
            OutboundSmsJobCoordinator.canInvokeSmsManager(
                OutboundSmsDispatchingResult(accepted = false, retryable = false, errorCode = "STALE_SMS_JOB_LEASE"),
                relayEnabled = true,
                deviceRevoked = false
            )
        )
        assertFalse(
            OutboundSmsJobCoordinator.canInvokeSmsManager(
                OutboundSmsDispatchingResult(accepted = true, retryable = false, simSlot = 1),
                relayEnabled = false,
                deviceRevoked = false
            )
        )
        assertFalse(
            OutboundSmsJobCoordinator.canInvokeSmsManager(
                OutboundSmsDispatchingResult(accepted = true, retryable = false, simSlot = 1),
                relayEnabled = true,
                deviceRevoked = true
            )
        )
    }

    @Test
    fun resultReports_preserveHonestSubmittedVsDeliveredSeparationAndMergeOrder() {
        val submitted = OutboundSmsJobCoordinator.buildSubmittedReport("job-1", "lease-abc", 1, partsCount = 2)
        val delivered = OutboundSmsJobCoordinator.buildDeliveredReport("job-1", "lease-abc", 1)
        assertEquals("SUBMITTED", submitted.outcome)
        assertEquals("DELIVERED", delivered.outcome)
        assertNotEquals(submitted.outcome, delivered.outcome)

        // Delivered cannot be downgraded back to SUBMITTED on stale retry
        val afterDelivered = OutboundSmsJobCoordinator.mergePendingReport(listOf(submitted), delivered)
        assertEquals(1, afterDelivered.size)
        assertEquals("DELIVERED", afterDelivered[0].outcome)

        val downgradeAttempt = OutboundSmsJobCoordinator.mergePendingReport(afterDelivered, submitted)
        assertEquals(1, downgradeAttempt.size)
        assertEquals("DELIVERED", downgradeAttempt[0].outcome)

        // Reconciliation removes only the acknowledged outcome
        val cleared = OutboundSmsJobCoordinator.removePendingReport(downgradeAttempt, "job-1", "DELIVERED")
        assertTrue(cleared.isEmpty())
    }
}
