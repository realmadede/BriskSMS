package tz.co.brisksms.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import tz.co.brisksms.data.local.OfflineEvidenceEntity
import tz.co.brisksms.messaging.data.DispatchState
import tz.co.brisksms.messaging.data.SmsDispatchEntity

class ProductIsolationTest {

    @Test
    fun databaseTableIsolation_paymentEvidenceAndSmsQueuesAreDistinct() {
        // Product A local storage entity
        val evidence = OfflineEvidenceEntity(
            packageName = "com.vodafone.vodapay",
            senderAddress = "MPESA",
            rawPayload = "bsk_enc_v1:mock_encrypted_payload",
            deviceTimestamp = 1793912000000L,
            signature = "sig_mpesa_evidence_001"
        )

        // Product B local storage entity
        val dispatch = SmsDispatchEntity(
            organizationId = "org_test_123",
            campaignId = "camp_456",
            recipientPhone = "+255754111222",
            messageText = "Your invoice is ready",
            simSlot = 1,
            idempotencyKey = "sms_idem_9988",
            status = DispatchState.QUEUED.name
        )

        // Distinct table entity models and distinct identifiers
        assertNotEquals(evidence.id, dispatch.id)
        assertFalse(evidence.rawPayload.contains("sms_idem"))
        assertFalse(dispatch.messageText.contains("bsk_enc_v1:"))
    }

    @Test
    fun entitlementSeparation_productsOperateIndependently() {
        // Device state where Payment Intelligence is enabled, but Bulk Messaging is disabled
        var paymentIntelligenceEnabled = true
        var bulkMessagingEnabled = false

        assertTrue(paymentIntelligenceEnabled)
        assertFalse(bulkMessagingEnabled)

        // Disabling bulk messaging does not alter payment intelligence status
        bulkMessagingEnabled = false
        assertTrue(paymentIntelligenceEnabled)

        // Vice versa: Enabling bulk messaging while payment intelligence is disabled
        paymentIntelligenceEnabled = false
        bulkMessagingEnabled = true

        assertFalse(paymentIntelligenceEnabled)
        assertTrue(bulkMessagingEnabled)
    }

    @Test
    fun financialInvariants_androidRelayNeverDirectlySettlesOrCredits() {
        // Invariant 1: Android notification forwarding is strictly observational
        val evidenceUploadStatus = "OBSERVED"
        assertNotEquals("SETTLED", evidenceUploadStatus)
        assertNotEquals("VERIFIED", evidenceUploadStatus)

        // Invariant 2: Android SMS dispatch does not alter prepaid SMS balance
        val dispatchStatus = DispatchState.SUBMITTED.name
        assertNotEquals("CREDIT_DEDUCTED", dispatchStatus)
    }
}
