package tz.co.brisksms.payment.parser

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ProviderNotificationParserTest {

    @Test
    fun parseMpesaNotification_validPayload_succeeds() {
        val payload = "09J8K7L6M5 Imethibitishwa. Umepokea Tsh 45,000 kutoka kwa John Doe 0754123456 tarehe 05/11/2026."
        val result = ProviderNotificationParser.parse("MPESA", payload)

        assertNotNull(result)
        assertEquals("MPESA", result?.provider)
        assertEquals("09J8K7L6M5", result?.reference)
        assertEquals(4500000L, result?.amountCents)
        assertEquals("+255754123456", result?.senderPhone)
        assertEquals("John Doe", result?.senderName)
        assertEquals("TZS", result?.currency)
    }

    @Test
    fun parseMpesaNotification_withDecimalAmount_succeeds() {
        val payload = "09J8K7L6M6 Imethibitishwa. Umepokea Tsh 1500.50 kutoka kwa Neema Juma 0765998877 tarehe 06/11/2026."
        val result = ProviderNotificationParser.parse("MPESA", payload)

        assertNotNull(result)
        assertEquals("MPESA", result?.provider)
        assertEquals("09J8K7L6M6", result?.reference)
        assertEquals(150050L, result?.amountCents)
        assertEquals("+255765998877", result?.senderPhone)
        assertEquals("Neema Juma", result?.senderName)
    }

    @Test
    fun parseMpesaNotification_withInternationalPhone_succeeds() {
        val payload = "09J8K7L6M7 Imethibitishwa. Umepokea Tsh 100,000 kutoka kwa Baraka Rashid +255754987654 tarehe 06/11/2026."
        val result = ProviderNotificationParser.parse("MPESA", payload)

        assertNotNull(result)
        assertEquals("+255754987654", result?.senderPhone)
        assertEquals(10000000L, result?.amountCents)
    }

    @Test
    fun parseMixxNotification_validPayload_succeeds() {
        val payload = "87A65B43C2 Imethibitishwa. Umepokea TSh 12,500.00 kutoka 0713987654 - Jane Doe tarehe 05/11/2026."
        val result = ProviderNotificationParser.parse("Mixx", payload)

        assertNotNull(result)
        assertEquals("MIXX", result?.provider)
        assertEquals("87A65B43C2", result?.reference)
        assertEquals(1250000L, result?.amountCents)
        assertEquals("+255713987654", result?.senderPhone)
        assertEquals("Jane Doe", result?.senderName)
    }

    @Test
    fun parseAirtelNotification_validPayload_succeeds() {
        val payload = "Kumbukumbu Namba: TX998877 Umepokea Tsh 30,000 kutoka Ali Hassan 0784112233 salio jipya ni Tsh 150,000."
        val result = ProviderNotificationParser.parse("AirtelMoney", payload)

        assertNotNull(result)
        assertEquals("AIRTEL", result?.provider)
        assertEquals("TX998877", result?.reference)
        assertEquals(3000000L, result?.amountCents)
        assertEquals("+255784112233", result?.senderPhone)
        assertEquals("Ali Hassan", result?.senderName)
    }

    @Test
    fun parseCrdbNotification_validPayload_succeeds() {
        val payload = "Umelipwa TZS 250,000 kutoka Sarah Peter Kumbukumbu: CRDB9911."
        val result = ProviderNotificationParser.parse("CRDB", payload)

        assertNotNull(result)
        assertEquals("CRDB", result?.provider)
        assertEquals("CRDB9911", result?.reference)
        assertEquals(25000000L, result?.amountCents)
        assertEquals("Sarah Peter", result?.senderName)
        assertNull(result?.senderPhone)
    }

    @Test
    fun parsePersonalMessage_returnsNull() {
        val personalMsg = "Mambo vipi bro, tutaonana kesho asubuhi saa nne pale Posta."
        val result = ProviderNotificationParser.parse("0712345678", personalMsg)

        assertNull(result)
    }

    @Test
    fun parseUnsupportedNotification_returnsNull() {
        val otpMsg = "Your verification code is 492019. Valid for 5 minutes."
        val result = ProviderNotificationParser.parse("Google", otpMsg)

        assertNull(result)
    }

    @Test
    fun parseEmptyOrBlank_returnsNull() {
        assertNull(ProviderNotificationParser.parse("MPESA", ""))
        assertNull(ProviderNotificationParser.parse("MPESA", "    "))
    }
}
