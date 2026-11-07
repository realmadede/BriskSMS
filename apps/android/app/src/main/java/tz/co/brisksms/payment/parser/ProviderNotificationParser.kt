package tz.co.brisksms.payment.parser

import java.util.regex.Pattern

data class ParsedNotificationResult(
    val provider: String,
    val reference: String,
    val amountCents: Long,
    val currency: String = "TZS",
    val senderPhone: String?,
    val senderName: String?,
    val customerMemo: String?,
    val confidence: Float,
    val parserVersion: String = "1.0.0"
)

/**
 * Android Local Payment Notification Parser
 * Normalizes Tanzanian Mobile Money & Bank notifications before encrypted persistence.
 * Never fabricates missing or ambiguous values.
 */
object ProviderNotificationParser {

    private val MPESA_PATTERN = Pattern.compile(
        "^([A-Z0-9]{8,12})\\s+(?:Imethibitishwa|Confirmed)\\.\\s+Umepokea\\s+Tsh\\s*([\\d,]+(?:\\.\\d{2})?)\\s+kutoka\\s+kwa\\s+([^0-9]+?)\\s+(\\+?255\\d{9}|0\\d{9})",
        Pattern.CASE_INSENSITIVE
    )

    private val MIXX_PATTERN = Pattern.compile(
        "^([A-Z0-9]{8,12})\\s+Imethibitishwa\\.\\s+Umepokea\\s+TSh\\s*([\\d,]+(?:\\.\\d{2})?)\\s+kutoka\\s+(\\+?255\\d{9}|0\\d{9})\\s*-\\s*([^.]+?)\\s+tarehe",
        Pattern.CASE_INSENSITIVE
    )

    private val AIRTEL_PATTERN = Pattern.compile(
        "Kumbukumbu\\s+Namba:\\s*([A-Z0-9.]+)\\s+Umepokea\\s+Tsh\\s*([\\d,]+)\\s+kutoka\\s+([^0-9]+?)\\s+(\\+?255\\d{9}|0\\d{9})",
        Pattern.CASE_INSENSITIVE
    )

    private val CRDB_PATTERN = Pattern.compile(
        "Umelipwa\\s+TZS\\s*([\\d,]+(?:\\.\\d{2})?)\\s+kutoka\\s+([^0-9]+?)\\s+Kumbukumbu:\\s*([A-Z0-9]+)",
        Pattern.CASE_INSENSITIVE
    )

    fun parse(senderAddress: String, rawPayload: String): ParsedNotificationResult? {
        val clean = rawPayload.trim()

        // 1. Vodacom M-Pesa
        val mpesaMatch = MPESA_PATTERN.matcher(clean)
        if (mpesaMatch.find()) {
            val ref = mpesaMatch.group(1)?.uppercase() ?: return null
            val amt = parseAmountCents(mpesaMatch.group(2) ?: "")
            val name = mpesaMatch.group(3)?.trim()
            val phone = normalizePhone(mpesaMatch.group(4) ?: "")
            return ParsedNotificationResult(
                provider = "MPESA",
                reference = ref,
                amountCents = amt,
                senderPhone = phone,
                senderName = name,
                customerMemo = null,
                confidence = 0.98f
            )
        }

        // 2. Mixx by Yas (Tigo Pesa)
        val mixxMatch = MIXX_PATTERN.matcher(clean)
        if (mixxMatch.find()) {
            val ref = mixxMatch.group(1)?.uppercase() ?: return null
            val amt = parseAmountCents(mixxMatch.group(2) ?: "")
            val phone = normalizePhone(mixxMatch.group(3) ?: "")
            val name = mixxMatch.group(4)?.trim()
            return ParsedNotificationResult(
                provider = "MIXX",
                reference = ref,
                amountCents = amt,
                senderPhone = phone,
                senderName = name,
                customerMemo = null,
                confidence = 0.98f
            )
        }

        // 3. Airtel Money
        val airtelMatch = AIRTEL_PATTERN.matcher(clean)
        if (airtelMatch.find()) {
            val ref = airtelMatch.group(1)?.replace(".", "")?.uppercase() ?: return null
            val amt = parseAmountCents(airtelMatch.group(2) ?: "")
            val name = airtelMatch.group(3)?.trim()
            val phone = normalizePhone(airtelMatch.group(4) ?: "")
            return ParsedNotificationResult(
                provider = "AIRTEL",
                reference = ref,
                amountCents = amt,
                senderPhone = phone,
                senderName = name,
                customerMemo = null,
                confidence = 0.95f
            )
        }

        // 4. CRDB Bank
        val crdbMatch = CRDB_PATTERN.matcher(clean)
        if (crdbMatch.find()) {
            val amt = parseAmountCents(crdbMatch.group(1) ?: "")
            val name = crdbMatch.group(2)?.trim()
            val ref = crdbMatch.group(3)?.uppercase() ?: return null
            return ParsedNotificationResult(
                provider = "CRDB",
                reference = ref,
                amountCents = amt,
                senderPhone = null,
                senderName = name,
                customerMemo = null,
                confidence = 0.92f
            )
        }

        return null
    }

    private fun parseAmountCents(rawStr: String): Long {
        val sanitized = rawStr.replace(",", "").trim()
        val decimalIndex = sanitized.indexOf('.')
        return if (decimalIndex == -1) {
            sanitized.toLongOrNull()?.times(100) ?: 0L
        } else {
            val major = sanitized.substring(0, decimalIndex).toLongOrNull() ?: 0L
            val minorStr = sanitized.substring(decimalIndex + 1).padEnd(2, '0').take(2)
            val minor = minorStr.toLongOrNull() ?: 0L
            major * 100 + minor
        }
    }

    private fun normalizePhone(rawPhone: String): String {
        val digits = rawPhone.replace(Regex("[^0-9]"), "")
        return when {
            digits.startsWith("255") && digits.length == 12 -> "+$digits"
            digits.startsWith("0") && digits.length == 10 -> "+255${digits.substring(1)}"
            digits.length == 9 -> "+255$digits"
            else -> "+$digits"
        }
    }
}
