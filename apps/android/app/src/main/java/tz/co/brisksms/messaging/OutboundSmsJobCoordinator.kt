package tz.co.brisksms.messaging

import tz.co.brisksms.messaging.data.DispatchState
import tz.co.brisksms.messaging.data.SmsDispatchEntity

/**
 * Remote SMSGate outbound job leased from POST /v1/messaging/device-jobs/acquire.
 */
data class OutboundSmsJobPayload(
    val id: String,
    val organizationId: String,
    val messageId: String,
    val recipientPhone: String,
    val messageText: String,
    val simSlot: Int,
    val leaseToken: String,
    val idempotencyKey: String? = null,
    val status: String = "CLAIMED",
    val leaseExpiresAt: String? = null,
    val expiresAt: String? = null,
    val attemptCount: Int = 1,
    val maxAttempts: Int = 2
)

data class AcquireOutboundSmsJobsResponse(
    val jobs: List<OutboundSmsJobPayload>,
    val relayEnabled: Boolean
)

data class OutboundSmsDispatchingResult(
    val accepted: Boolean,
    val retryable: Boolean,
    val simSlot: Int? = null,
    val errorCode: String? = null,
    val errorMessage: String? = null
)

data class OutboundSmsJobResultReport(
    val jobId: String,
    val leaseToken: String,
    val outcome: String, // SUBMITTED | DELIVERED | FAILED | UNCERTAIN
    val simSlot: Int? = null,
    val partsCount: Int? = null,
    val radioResultCode: Int? = null,
    val gatewayReference: String? = null,
    val errorMessage: String? = null,
    val failureCode: String? = null,
    val preRadioFailure: Boolean = false,
    val carrierTimestamp: String? = null
)

data class OutboundSmsJobResultAck(
    val accepted: Boolean,
    val retryable: Boolean,
    val idempotentReplay: Boolean = false,
    val serverStatus: String? = null,
    val errorCode: String? = null
)

data class SimSlotCapability(
    val simNumber: Int,
    val isReady: Boolean,
    val sentTodayCount: Int = 0
)

sealed class JobValidationResult {
    data class Valid(val job: OutboundSmsJobPayload) : JobValidationResult()
    data class Invalid(val failureCode: String, val reason: String) : JobValidationResult()
}

sealed class SimSelectionOutcome {
    data class Selected(val simSlot: Int) : SimSelectionOutcome()
    data class Unavailable(val failureCode: String, val reason: String) : SimSelectionOutcome()
}

/**
 * Pure Kotlin coordinator for Android outbound SMSGate job lifecycle invariants:
 * - Validates leased jobs fail-closed (no blank destination, text, jobId, or leaseToken).
 * - Selects SIM slot strictly from device hardware capability and daily quota (never recipient prefix).
 * - Enforces duplicate-dispatch protection against re-sending DISPATCHING/SUBMITTED/DELIVERED/UNKNOWN jobs.
 * - Requires backend /dispatching acceptance before calling SmsManager.
 * - Reconciles durable Keystore-encrypted pending job result reports across network drops and process death.
 */
object OutboundSmsJobCoordinator {

    val NON_REENTRANT_LOCAL_STATES = setOf(
        DispatchState.DISPATCHING.name,
        DispatchState.SUBMITTED.name,
        DispatchState.DELIVERED.name,
        DispatchState.UNKNOWN.name
    )

    val VALID_OUTCOMES = setOf("SUBMITTED", "DELIVERED", "FAILED", "UNCERTAIN")

    fun validateAcquiredJob(job: OutboundSmsJobPayload): JobValidationResult {
        if (job.id.isBlank()) {
            return JobValidationResult.Invalid("INVALID_JOB_ID", "Outbound SMS job id is blank")
        }
        if (job.organizationId.isBlank()) {
            return JobValidationResult.Invalid("INVALID_ORG", "Outbound SMS job organizationId is blank")
        }
        if (job.leaseToken.isBlank()) {
            return JobValidationResult.Invalid("MISSING_LEASE_TOKEN", "Outbound SMS job leaseToken is missing")
        }
        if (job.recipientPhone.isBlank() || !job.recipientPhone.startsWith("+") || job.recipientPhone.length < 10) {
            return JobValidationResult.Invalid("INVALID_RECIPIENT", "Recipient phone '${job.recipientPhone}' is not valid E.164")
        }
        if (job.messageText.isBlank()) {
            return JobValidationResult.Invalid("EMPTY_MESSAGE", "Outbound SMS messageText cannot be blank")
        }
        if (job.simSlot != 1 && job.simSlot != 2) {
            return JobValidationResult.Invalid("INVALID_SIM_SLOT", "SIM slot '${job.simSlot}' must be 1 or 2")
        }
        return JobValidationResult.Valid(job)
    }

    /**
     * Prevents duplicate SmsManager transmission if the device already initiated radio dispatch
     * or already queued a pending server outcome report for the same jobId/idempotencyKey.
     */
    fun shouldSkipAcquiredJob(
        job: OutboundSmsJobPayload,
        existingByJob: SmsDispatchEntity?,
        existingByKey: SmsDispatchEntity?,
        pendingReports: List<OutboundSmsJobResultReport>
    ): Boolean {
        val local = existingByJob ?: existingByKey
        if (local != null && NON_REENTRANT_LOCAL_STATES.contains(local.status)) {
            return true
        }
        if (pendingReports.any { it.jobId == job.id && it.leaseToken == job.leaseToken }) {
            return true
        }
        return false
    }

    /**
     * Selects an available SIM slot without inspecting recipient MSISDN prefix.
     * Number portability in Tanzania decouples prefix from current carrier, so routing
     * must strictly honor device hardware SIM readiness, configured preferred slot, and daily caps.
     */
    fun selectDispatchSimSlot(
        requestedSlot: Int,
        preferredDeviceSlot: Int,
        activeSlots: List<SimSlotCapability>,
        dailyCapPerSim: Int
    ): SimSelectionOutcome {
        val readySlots = activeSlots.filter { it.isReady }
        if (readySlots.isEmpty()) {
            return SimSelectionOutcome.Unavailable(
                "NO_ACTIVE_SIM",
                "No active ready SIM slots detected on companion device"
            )
        }

        val candidates = listOf(requestedSlot, preferredDeviceSlot, 1, 2)
            .filter { it == 1 || it == 2 }
            .distinct()

        for (slot in candidates) {
            val match = readySlots.find { it.simNumber == slot }
            if (match != null && match.sentTodayCount < dailyCapPerSim) {
                return SimSelectionOutcome.Selected(match.simNumber)
            }
        }

        val anyUnderCap = readySlots.find { it.sentTodayCount < dailyCapPerSim }
        if (anyUnderCap != null) {
            return SimSelectionOutcome.Selected(anyUnderCap.simNumber)
        }

        return SimSelectionOutcome.Unavailable(
            "SIM_DAILY_CAP_REACHED",
            "All ready SIM slots reached daily safety cap ($dailyCapPerSim SMS/day)"
        )
    }

    fun toLocalDispatchEntity(
        job: OutboundSmsJobPayload,
        resolvedSimSlot: Int
    ): SmsDispatchEntity {
        val stableIdempotencyKey = job.idempotencyKey?.takeIf { it.isNotBlank() }
            ?: "smsgate_job_${job.id}"
        return SmsDispatchEntity(
            id = job.messageId.takeIf { it.isNotBlank() } ?: job.id,
            organizationId = job.organizationId,
            campaignId = null,
            jobId = job.id,
            leaseToken = job.leaseToken,
            recipientPhone = job.recipientPhone,
            messageText = job.messageText,
            simSlot = resolvedSimSlot,
            idempotencyKey = stableIdempotencyKey,
            status = DispatchState.QUEUED.name
        )
    }

    /**
     * Safety gate: Android must NEVER invoke SmsManager unless /dispatching returned accepted=true
     * and relay is still authorized.
     */
    fun canInvokeSmsManager(
        dispatchingResult: OutboundSmsDispatchingResult,
        relayEnabled: Boolean,
        deviceRevoked: Boolean
    ): Boolean {
        return dispatchingResult.accepted && relayEnabled && !deviceRevoked
    }

    fun buildPreRadioFailureReport(
        jobId: String,
        leaseToken: String,
        failureCode: String,
        errorMessage: String,
        simSlot: Int? = null
    ): OutboundSmsJobResultReport {
        return OutboundSmsJobResultReport(
            jobId = jobId,
            leaseToken = leaseToken,
            outcome = "FAILED",
            simSlot = simSlot,
            failureCode = failureCode,
            errorMessage = errorMessage,
            preRadioFailure = true
        )
    }

    fun buildSubmittedReport(
        jobId: String,
        leaseToken: String,
        simSlot: Int,
        partsCount: Int? = null,
        carrierTimestamp: String? = null
    ): OutboundSmsJobResultReport {
        return OutboundSmsJobResultReport(
            jobId = jobId,
            leaseToken = leaseToken,
            outcome = "SUBMITTED",
            simSlot = simSlot,
            partsCount = partsCount,
            carrierTimestamp = carrierTimestamp
        )
    }

    fun buildDeliveredReport(
        jobId: String,
        leaseToken: String,
        simSlot: Int,
        carrierTimestamp: String? = null
    ): OutboundSmsJobResultReport {
        return OutboundSmsJobResultReport(
            jobId = jobId,
            leaseToken = leaseToken,
            outcome = "DELIVERED",
            simSlot = simSlot,
            carrierTimestamp = carrierTimestamp
        )
    }

    fun buildRadioFailureReport(
        jobId: String,
        leaseToken: String,
        simSlot: Int,
        radioResultCode: Int,
        errorMessage: String
    ): OutboundSmsJobResultReport {
        return OutboundSmsJobResultReport(
            jobId = jobId,
            leaseToken = leaseToken,
            outcome = "FAILED",
            simSlot = simSlot,
            radioResultCode = radioResultCode,
            failureCode = "ANDROID_RADIO_ERROR_$radioResultCode",
            errorMessage = errorMessage,
            preRadioFailure = false
        )
    }

    private fun outcomeRank(outcome: String): Int {
        return when (outcome) {
            "DELIVERED", "FAILED" -> 3
            "SUBMITTED" -> 2
            "UNCERTAIN" -> 1
            else -> 0
        }
    }

    /**
     * Merges a pending result report without allowing an older/weaker outcome (e.g., UNCERTAIN or SUBMITTED)
     * to overwrite a stronger confirmed outcome (e.g., DELIVERED or FAILED) for the same jobId.
     */
    fun mergePendingReport(
        existing: List<OutboundSmsJobResultReport>,
        report: OutboundSmsJobResultReport,
        maxEntries: Int = 100
    ): List<OutboundSmsJobResultReport> {
        if (!VALID_OUTCOMES.contains(report.outcome)) return existing
        val prior = existing.find { it.jobId == report.jobId }
        if (prior != null && prior.leaseToken == report.leaseToken && outcomeRank(prior.outcome) > outcomeRank(report.outcome)) {
            return existing
        }
        val filtered = existing.filterNot { it.jobId == report.jobId } + report
        return if (filtered.size > maxEntries) filtered.takeLast(maxEntries) else filtered
    }

    fun removePendingReport(
        existing: List<OutboundSmsJobResultReport>,
        jobId: String,
        outcome: String
    ): List<OutboundSmsJobResultReport> {
        return existing.filterNot { it.jobId == jobId && it.outcome == outcome }
    }
}
