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
    fun isEligibleSmsSource_keepsIncomingCreditFromSupportedShortcodes() {
        // The same message shapes the server parser is tested on (packages/parser-engine/test/engine.test.ts)
        val samples = listOf(
            "M-PESA" to "QA12BC34DE Imethibitishwa. Umepokea Tsh50,000.00 kutoka kwa JOHN DOE 255754123456 tarehe 05/11/2026 saa 2:30 PM. Salio lako jipya la M-Pesa ni Tsh150,000.00.",
            "MIXX" to "Umepokea Tsh 30,000 kutoka kwa HASSAN ALI (255713456789). Kumbukumbu namba: 98765432101. Tarehe 05/11/2026 15:45. Salio jipya ni Tsh 120,000.",
            "AIRTELMONEY" to "Umepokea Tsh 15,000 kutoka kwa BARAKA JUMA (255784998877) tarehe 05/11/2026. Namba ya muamala: AM88990011. Salio jipya ni Tsh 45,000.",
            "HALOPESA" to "Umepokea Tsh 12,500.5 kutoka kwa SALUM RASHID (255622112233) tarehe 05/11/2026 saa 09:15. Kumbukumbu: HP99887766.",
            "CRDB" to "CRDB Alert: Credit of TZS 150,000.00 to A/C 01J204839200 from KIBWANA SAIDI Ref: FT2631589402 on 05-Nov-2026. Avail Bal: TZS 1,450,000.00.",
            "M-PESA" to "ABC123XYZ Confirmed. You have received Tsh 50,000 from JOHN 0712345678"
        )
        samples.forEach { (sender, body) ->
            assertTrue("Expected to keep $sender: $body", PaymentProviderRegistry.isEligibleSmsSource(sender, body))
        }
    }

    @Test
    fun isEligibleSmsSource_dropsPersonalNumbersOtherSendersAndOutgoingMoney() {
        val credit = "QA12BC34DE Imethibitishwa. Umepokea Tsh 50,000 kutoka kwa JOHN"
        assertTrue(PaymentProviderRegistry.isEligibleSmsSource("M-PESA", credit))
        assertFalse(PaymentProviderRegistry.isEligibleSmsSource("+255712345678", credit))
        assertFalse(PaymentProviderRegistry.isEligibleSmsSource("0712345678", credit))
        assertFalse(PaymentProviderRegistry.isEligibleSmsSource("SHOP", credit))
        assertFalse(PaymentProviderRegistry.isEligibleSmsSource("M-PESA", "ABC123XYZ Confirmed. You paid Tsh 5,000 to DUKA"))
        assertFalse(PaymentProviderRegistry.isEligibleSmsSource("M-PESA", "QA12BC34DE Imethibitishwa. Umetuma Tsh 5,000 kwa DUKA"))
        assertFalse(PaymentProviderRegistry.isEligibleSmsSource("CRDB", "CRDB Alert: Debit of TZS 150,000.00 from A/C 01J204839200 Ref: FT99887766"))
    }

    @Test
    fun isEligibleSmsSource_dropsPromosBalancesAndCodesFromSupportedSenders() {
        assertFalse(PaymentProviderRegistry.isEligibleSmsSource("M-PESA", "Your verification code is 482913"))
        assertFalse(PaymentProviderRegistry.isEligibleSmsSource("AIRTEL", "Confirmed: your bundle is active. Reply STOP to opt out"))
        assertFalse(PaymentProviderRegistry.isEligibleSmsSource("M-PESA", "Salio lako la M-Pesa ni Tsh 150,000.00"))
        // Has a credit phrase and an amount but no transaction reference
        assertFalse(PaymentProviderRegistry.isEligibleSmsSource("M-PESA", "Umepokea bonasi ya Tsh 500 kwa kutumia M-Pesa leo"))
        // "Refund" is not the label "Ref"
        assertFalse(PaymentProviderRegistry.isEligibleSmsSource("CRDB", "You have received Tsh 5,000 refund policy update"))
    }

    @Test
    fun classifyMessage_saysWhyATextWasDropped() {
        val payment = "QA12BC34DE Imethibitishwa. Umepokea Tsh 50,000 kutoka kwa JOHN"
        assertEquals(MessageVerdict.KEPT, PaymentProviderRegistry.classifyMessage("M-PESA", payment))
        assertEquals(MessageVerdict.PERSONAL_NUMBER, PaymentProviderRegistry.classifyMessage("+255712345678", payment))
        assertEquals(MessageVerdict.OTHER_SENDER, PaymentProviderRegistry.classifyMessage("SHOP", payment))
        assertEquals(MessageVerdict.OUTGOING_MONEY, PaymentProviderRegistry.classifyMessage("M-PESA", "QA12BC34DE Imethibitishwa. Umetuma Tsh 5,000 kwa DUKA"))
        assertEquals(MessageVerdict.NOT_A_PAYMENT, PaymentProviderRegistry.classifyMessage("M-PESA", "Your verification code is 482913"))
        assertTrue(MessageVerdict.NOT_A_PAYMENT.senderIsSupported)
        assertFalse(MessageVerdict.OTHER_SENDER.senderIsSupported)
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
