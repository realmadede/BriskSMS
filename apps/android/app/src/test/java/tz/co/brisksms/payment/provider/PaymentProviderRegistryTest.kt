package tz.co.brisksms.payment.provider

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PaymentProviderRegistryTest {

    @Test
    fun isAuthorizedPackage_acceptsVerifiedPlayStorePackages() {
        val verifiedPackages = listOf(
            "com.vodacom.mpesa",
            "tz.tigo.mfsapp",
            "com.airtel.africa.selfcare",
            "com.halopesa.eu",
            "com.crdb.simbanking",
            "com.nmb.mkononi"
        )

        verifiedPackages.forEach { pkg ->
            assertTrue("Expected $pkg to be authorized", PaymentProviderRegistry.isAuthorizedPackage(pkg))
            val info = PaymentProviderRegistry.getAppInfo(pkg)
            assertNotNull(info)
            assertEquals(PackageVerificationStatus.VERIFIED_PLAY_STORE, info?.status)
        }
    }

    @Test
    fun isAuthorizedPackage_rejectsPersonalAndSocialApps() {
        val unauthorizedPackages = listOf(
            "com.whatsapp",
            "org.telegram.messenger",
            "com.facebook.katana",
            "com.instagram.android",
            "com.google.android.apps.messaging",
            "com.google.android.gm"
        )

        unauthorizedPackages.forEach { pkg ->
            assertFalse("Expected $pkg to be rejected", PaymentProviderRegistry.isAuthorizedPackage(pkg))
            assertNull(PaymentProviderRegistry.getAppInfo(pkg))
        }
    }

    @Test
    fun isFinancialShortcode_matchesKnownTanzanianProviders() {
        assertTrue(PaymentProviderRegistry.isFinancialShortcode("M-PESA", "Umepokea Tsh 10,000"))
        assertTrue(PaymentProviderRegistry.isFinancialShortcode("MIXX", "Imethibitishwa"))
        assertTrue(PaymentProviderRegistry.isFinancialShortcode("CRDB", "Umelipwa TZS 50,000"))
        assertTrue(PaymentProviderRegistry.isFinancialShortcode("AIRTELMONEY", "TX123456"))

        // False positives should be rejected
        assertFalse(PaymentProviderRegistry.isFinancialShortcode("Dad", "Hello son, how are you?"))
        assertFalse(PaymentProviderRegistry.isFinancialShortcode("Uber", "Your ride has arrived"))
        assertFalse(PaymentProviderRegistry.isFinancialShortcode("+255754000111", "Umepokea M-PESA Tsh 10,000"))
        assertFalse(PaymentProviderRegistry.isFinancialShortcode("M-PESA", "Umetuma Tsh 10,000 kwenda John"))
    }

    @Test
    fun isEligibleNotificationSource_blocksWhatsAppAndSocialAppsMentionsOfMpesa() {
        assertFalse(
            PaymentProviderRegistry.isEligibleNotificationSource(
                "com.whatsapp",
                "M-PESA",
                "Umepokea Tsh 50,000 kutoka kwa Juma"
            )
        )
        assertFalse(
            PaymentProviderRegistry.isEligibleNotificationSource(
                "com.google.android.apps.messaging",
                "+255754123456",
                "QA12BC34DE Imethibitishwa. Umepokea Tsh 50,000 kutoka kwa JOHN DOE 255754123456"
            )
        )
        assertTrue(
            PaymentProviderRegistry.isEligibleNotificationSource(
                "com.google.android.apps.messaging",
                "M-PESA",
                "QA12BC34DE Imethibitishwa. Umepokea Tsh 50,000 kutoka kwa JOHN DOE 255754123456"
            )
        )
        assertTrue(
            PaymentProviderRegistry.isEligibleNotificationSource(
                "com.vodacom.mpesa",
                "M-Pesa",
                "You have received Tsh 25,000 from Ali"
            )
        )
    }
}
