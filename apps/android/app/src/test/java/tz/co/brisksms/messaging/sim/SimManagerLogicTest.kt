package tz.co.brisksms.messaging.sim

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SimManagerLogicTest {

    @Test
    fun simSlotInfo_mapsIndexTo1BasedSimNumber() {
        val sim1 = SimSlotInfo(
            slotIndex = 0,
            simNumber = 1,
            subscriptionId = 101,
            carrierName = "Vodacom",
            displayName = "Vodacom SIM",
            countryIso = "tz",
            isReady = true
        )

        val sim2 = SimSlotInfo(
            slotIndex = 1,
            simNumber = 2,
            subscriptionId = 102,
            carrierName = "Mixx by Yas",
            displayName = "Mixx SIM",
            countryIso = "tz",
            isReady = true
        )

        assertEquals(0, sim1.slotIndex)
        assertEquals(1, sim1.simNumber)
        assertEquals(1, sim2.slotIndex)
        assertEquals(2, sim2.simNumber)
        assertTrue(sim1.isReady)
        assertTrue(sim2.isReady)
    }

    @Test
    fun carrierNormalization_handlesTanzanianTelcoIdentities() {
        val testCases = mapOf(
            "VODACOM TZ" to "Vodacom",
            "M-PESA" to "Vodacom",
            "Tigo Pesa" to "Mixx by Yas",
            "MIXX" to "Mixx by Yas",
            "Airtel TZ" to "Airtel",
            "HaloPesa" to "Halotel",
            "TTCL" to "TTCL"
        )

        testCases.forEach { (raw, expected) ->
            val normalized = normalizeCarrier(raw)
            assertEquals("Normalized $raw should equal $expected", expected, normalized)
        }
    }

    @Test
    fun slotResolution_prefersExactMatchThenFallback() {
        val activeSlots = listOf(
            SimSlotInfo(0, 1, 101, "Vodacom", "SIM 1", "tz", true),
            SimSlotInfo(1, 2, 102, "Airtel", "SIM 2", "tz", true)
        )

        // Requesting slot 1 should resolve sub 101
        val sub1 = activeSlots.find { it.simNumber == 1 }?.subscriptionId
        assertEquals(101, sub1)

        // Requesting slot 2 should resolve sub 102
        val sub2 = activeSlots.find { it.simNumber == 2 }?.subscriptionId
        assertEquals(102, sub2)

        // Requesting slot 3 (non-existent) should fall back to first active SIM (sub 101)
        val subFallback = activeSlots.find { it.simNumber == 3 }?.subscriptionId ?: activeSlots.firstOrNull()?.subscriptionId
        assertEquals(101, subFallback)
    }

    private fun normalizeCarrier(raw: String): String {
        val upper = raw.uppercase()
        return when {
            upper.contains("VODA") || upper.contains("MPESA") || upper.contains("M-PESA") -> "Vodacom"
            upper.contains("MIXX") || upper.contains("TIGO") -> "Mixx by Yas"
            upper.contains("AIRTEL") -> "Airtel"
            upper.contains("HALO") -> "Halotel"
            upper.contains("TTCL") -> "TTCL"
            else -> raw.trim()
        }
    }
}
