package tz.co.brisksms.core.network

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import tz.co.brisksms.ui.pairing.PairingUrlValidator

class EvidenceUploadAndPairingPolicyTest {

    @Test
    fun classifyUploadResponse_rejects409CrossTenantDisputeAsPermanentFailure() {
        val outcome = BriskApiClient.classifyEvidenceUploadResponse(
            409,
            """{"success":false,"error":{"code":"CROSS_TENANT_DISPUTE","message":"Reference claimed by another organization"}}"""
        )

        assertTrue(outcome is UploadResponseClassification.Rejected)
        val rejected = outcome as UploadResponseClassification.Rejected
        assertEquals("CROSS_TENANT_DISPUTE", rejected.errorCode)
        assertFalse(rejected.retryable)
        assertTrue(rejected.permanentFailure)
    }

    @Test
    fun classifyUploadResponse_acceptsTrueIdempotent409Duplicate() {
        val outcome = BriskApiClient.classifyEvidenceUploadResponse(
            409,
            """{"success":true,"data":{"evidenceId":"ev_1","status":"DUPLICATE"}}"""
        )

        assertTrue(outcome is UploadResponseClassification.Accepted)
        val accepted = outcome as UploadResponseClassification.Accepted
        assertEquals("DUPLICATE", accepted.ack.status)
        assertEquals("ev_1", accepted.ack.evidenceId)
    }

    @Test
    fun classifyUploadResponse_treats429And503AsRetryableAnd422AsPermanent() {
        val rateLimited = BriskApiClient.classifyEvidenceUploadResponse(429, """{"error":{"code":"RATE_LIMIT"}}""")
        assertTrue(rateLimited is UploadResponseClassification.Rejected)
        assertTrue((rateLimited as UploadResponseClassification.Rejected).retryable)
        assertFalse(rateLimited.permanentFailure)

        val malformed = BriskApiClient.classifyEvidenceUploadResponse(422, """{"error":{"code":"VALIDATION_ERROR"}}""")
        assertTrue(malformed is UploadResponseClassification.Rejected)
        assertFalse((malformed as UploadResponseClassification.Rejected).retryable)
        assertTrue(malformed.permanentFailure)
    }

    @Test
    fun pairingUrlValidator_enforcesHttpsAndStripsV1Suffix() {
        assertEquals(
            "https://api.brisksms.app",
            PairingUrlValidator.normalizeAndValidateHttpsBaseUrl("https://api.brisksms.app/v1/")
        )

        var threwCleartext = false
        try {
            PairingUrlValidator.normalizeAndValidateHttpsBaseUrl("http://insecure.brisksms.app")
        } catch (_: IllegalArgumentException) {
            threwCleartext = true
        }
        assertTrue("Expected cleartext HTTP endpoint to be rejected", threwCleartext)
    }
}
