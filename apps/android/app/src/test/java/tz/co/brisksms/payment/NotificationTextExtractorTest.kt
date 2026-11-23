package tz.co.brisksms.payment

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import tz.co.brisksms.payment.provider.PaymentProviderRegistry

class NotificationTextExtractorTest {

    private val payment = "QA12BC34DE Imethibitishwa. Umepokea Tsh50,000.00 kutoka kwa JOHN DOE 255754123456 tarehe 05/11/2026."

    @Test
    fun prefersBigTextOverTruncatedText() {
        val result = NotificationTextExtractor.candidates("M-PESA", null, "QA12BC34DE Imethibitishwa. Umepokea Ts…", payment, emptyList(), emptyList())
        assertEquals(listOf(NotificationText("M-PESA", payment)), result)
    }

    @Test
    fun findsAPaymentHiddenBehindANewerMessageInAGroupedNotification() {
        val result = NotificationTextExtractor.candidates(
            title = "2 new messages",
            conversationTitle = null,
            text = "Your bundle expires tomorrow",
            bigText = "",
            textLines = emptyList(),
            messages = listOf(
                NotificationText("M-PESA", payment, 1L),
                NotificationText("AIRTEL", "Your bundle expires tomorrow", 2L)
            )
        )
        val kept = result.filter { PaymentProviderRegistry.isEligibleNotificationSource("com.google.android.apps.messaging", it.sender, it.body) }
        assertEquals(listOf(NotificationText("M-PESA", payment, 1L)), kept)
    }

    @Test
    fun usesTheConversationTitleWhenAMessageHasNoSender() {
        val result = NotificationTextExtractor.candidates("", "M-PESA", "", "", listOf(payment), emptyList())
        assertEquals("M-PESA", result.single().sender)
    }

    @Test
    fun fillsAMissingMessageSenderFromTheTitle() {
        val result = NotificationTextExtractor.candidates("M-PESA", null, "", "", emptyList(), listOf(NotificationText("", payment, 5L)))
        assertEquals(NotificationText("M-PESA", payment, 5L), result.single())
    }

    @Test
    fun dropsEmptyAndRepeatedTexts() {
        val result = NotificationTextExtractor.candidates("M-PESA", null, "  ", payment, listOf(payment, ""), listOf(NotificationText("M-PESA", payment)))
        assertEquals(1, result.size)
        assertTrue(result.single().body == payment)
    }
}
