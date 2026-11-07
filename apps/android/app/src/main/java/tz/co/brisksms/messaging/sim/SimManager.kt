package tz.co.brisksms.messaging.sim

import android.content.Context
import android.os.Build
import android.telephony.SubscriptionInfo
import android.telephony.SubscriptionManager
import android.telephony.TelephonyManager
import android.util.Log

data class SimSlotInfo(
    val slotIndex: Int,          // 0 for SIM 1, 1 for SIM 2
    val simNumber: Int,          // 1-based (1 or 2)
    val subscriptionId: Int,
    val carrierName: String,     // e.g. "Vodacom", "Mixx by Yas", "Airtel", "Halotel"
    val displayName: String,
    val countryIso: String,
    val isReady: Boolean
)

/**
 * Android Cellular SIM Management Service
 * Detects single-SIM / dual-SIM subscriptions and resolves designated carrier slots.
 */
class SimManager(private val context: Context) {

    companion object {
        private const val TAG = "SimManager"
    }

    /**
     * Enumerates active SIM slots with carrier identification
     */
    fun getActiveSimSlots(): List<SimSlotInfo> {
        return try {
            val subscriptionManager = context.getSystemService(Context.TELEPHONY_SUBSCRIPTION_SERVICE) as? SubscriptionManager
                ?: return emptyList()

            val subs: List<SubscriptionInfo>? = try {
                subscriptionManager.activeSubscriptionInfoList
            } catch (e: SecurityException) {
                Log.w(TAG, "Missing READ_PHONE_STATE permission to query SIM slots: ${e.message}")
                null
            }

            if (subs.isNullOrEmpty()) {
                return emptyList()
            }

            subs.map { info ->
                val slot = info.simSlotIndex
                SimSlotInfo(
                    slotIndex = slot,
                    simNumber = slot + 1,
                    subscriptionId = info.subscriptionId,
                    carrierName = normalizeCarrierName(info.carrierName?.toString() ?: info.displayName?.toString() ?: "Unknown"),
                    displayName = info.displayName?.toString() ?: "SIM ${slot + 1}",
                    countryIso = info.countryIso ?: "tz",
                    isReady = true
                )
            }.sortedBy { it.slotIndex }
        } catch (e: Exception) {
            Log.e(TAG, "Error enumerating SIM slots: ${e.message}")
            emptyList()
        }
    }

    /**
     * Resolves subscription ID for a requested 1-based SIM slot (1 or 2)
     */
    fun resolveSubscriptionId(preferredSlot: Int = 1): Int? {
        val activeSlots = getActiveSimSlots()
        if (activeSlots.isEmpty()) return null

        val exactMatch = activeSlots.find { it.simNumber == preferredSlot }
        if (exactMatch != null) {
            return exactMatch.subscriptionId
        }

        // Fall back to first available SIM if designated slot is absent
        return activeSlots.firstOrNull()?.subscriptionId
    }

    private fun normalizeCarrierName(raw: String): String {
        val upper = raw.uppercase()
        return when {
            upper.contains("VODA") || upper.contains("MPESA") -> "Vodacom"
            upper.contains("MIXX") || upper.contains("TIGO") -> "Mixx by Yas"
            upper.contains("AIRTEL") -> "Airtel"
            upper.contains("HALO") -> "Halotel"
            upper.contains("TTCL") -> "TTCL"
            else -> raw.trim()
        }
    }
}
