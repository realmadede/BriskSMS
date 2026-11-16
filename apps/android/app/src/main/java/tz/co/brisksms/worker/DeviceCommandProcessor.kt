package tz.co.brisksms.worker

import tz.co.brisksms.core.network.DeviceCommandAckOutcome
import tz.co.brisksms.core.network.DeviceCommandAckPayload
import tz.co.brisksms.core.network.DeviceCommandPayload

/**
 * Pure Kotlin helper for fleet command validation, SIM slot checks, and durable ACK queue reconciliation.
 * Supports only the canonical 4-command allowlist implemented end-to-end by BriskSMS.
 */
object DeviceCommandProcessor {
    val ALLOWED_COMMAND_TYPES = setOf(
        "PAUSE_RELAY",
        "RESUME_RELAY",
        "SWITCH_SIM",
        "WIPE_AND_REVOKE"
    )

    fun isSupportedCommandType(type: String): Boolean {
        return ALLOWED_COMMAND_TYPES.contains(type)
    }

    /**
     * Validates a SWITCH_SIM slot parameter. Returns null when missing or outside 1..2.
     */
    fun parseValidatedSimSlot(rawSlot: Any?): Int? {
        val slot = when (rawSlot) {
            is Int -> rawSlot
            is Long -> rawSlot.toInt()
            is Number -> {
                val asDouble = rawSlot.toDouble()
                if (asDouble % 1.0 == 0.0) asDouble.toInt() else return null
            }
            else -> return null
        }
        return if (slot == 1 || slot == 2) slot else null
    }

    fun shouldSkipAlreadyPendingAck(
        command: DeviceCommandPayload,
        pendingAcks: List<DeviceCommandAckPayload>
    ): Boolean {
        return pendingAcks.any { it.commandId == command.id }
    }

    fun mergePendingAck(
        existing: List<DeviceCommandAckPayload>,
        newAck: DeviceCommandAckPayload,
        maxEntries: Int = 50
    ): List<DeviceCommandAckPayload> {
        val filtered = existing.filterNot { it.commandId == newAck.commandId } + newAck
        return if (filtered.size > maxEntries) {
            filtered.takeLast(maxEntries)
        } else {
            filtered
        }
    }

    fun reconcilePendingAcks(
        existing: List<DeviceCommandAckPayload>,
        outcomes: List<DeviceCommandAckOutcome>
    ): List<DeviceCommandAckPayload> {
        if (outcomes.isEmpty()) return existing
        val resolvedIds = outcomes.map { it.commandId }.toSet()
        return existing.filterNot { resolvedIds.contains(it.commandId) }
    }
}
