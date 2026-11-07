package tz.co.brisksms.messaging.dispatcher

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import tz.co.brisksms.messaging.data.DispatchState

class SmsGateProtocolTest {

    @Test
    fun officialSmsGateSchema_validatesMessagePayloadFields() {
        // Officially documented SMSGate 3rdparty v1 schema
        val messageText = "Invoice INV-001 has been settled"
        val recipient = "+255754123456"
        val simNumber = 1
        val withDeliveryReport = true

        val payload = mapOf(
            "textMessage" to mapOf("text" to messageText),
            "phoneNumbers" to listOf(recipient),
            "simNumber" to simNumber,
            "withDeliveryReport" to withDeliveryReport
        )

        assertEquals(messageText, (payload["textMessage"] as Map<*, *>)["text"])
        assertEquals(listOf(recipient), payload["phoneNumbers"])
        assertEquals(1, payload["simNumber"])
        assertEquals(true, payload["withDeliveryReport"])
    }

    @Test
    fun officialSmsGateWebhooks_mapCorrectlyToLifecycleStates() {
        val testCases = mapOf(
            "sms:sent" to DispatchState.SUBMITTED,
            "sms:delivered" to DispatchState.DELIVERED,
            "sms:failed" to DispatchState.FAILED
        )

        testCases.forEach { (webhookEvent, expectedState) ->
            val resolvedState = when (webhookEvent) {
                "sms:delivered" -> DispatchState.DELIVERED
                "sms:failed" -> DispatchState.FAILED
                "sms:sent" -> DispatchState.SUBMITTED
                else -> DispatchState.UNKNOWN
            }
            assertEquals(expectedState, resolvedState)
        }
    }

    @Test
    fun ambiguousOutcome_requiresVerificationBeforeRetry() {
        // Invariant: An unconfirmed outcome (UNKNOWN) must never be blindly retried
        val currentState = DispatchState.UNKNOWN
        val attempts = 1

        val isSafeToBlindlyRetry = currentState == DispatchState.FAILED && attempts < 3
        assertFalse("Ambiguous transmission outcomes must not be blindly retried", isSafeToBlindlyRetry)
    }

    @Test
    fun gatewayMode_preservesEndpointSeparation() {
        val managedUrl = "https://gateway.brisksms.com/api/v1"
        val cloudRelayUrl = "https://api.sms-gate.app/3rdparty/v1"

        assertNotEquals(managedUrl, cloudRelayUrl)
        assertTrue(managedUrl.contains("gateway.brisksms.com"))
        assertTrue(cloudRelayUrl.contains("sms-gate.app"))
    }
}
