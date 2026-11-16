package tz.co.brisksms.payment.provider

enum class PackageVerificationStatus {
    VERIFIED_PLAY_STORE,
    PROVISIONAL_ALIAS
}

data class RegisteredPaymentApp(
    val providerName: String,
    val packageName: String,
    val status: PackageVerificationStatus,
    val description: String
)

/**
 * Registry of Authorized Tanzanian Financial Notification Sources
 * Distinguishes verified Google Play Store application package identifiers from provisional aliases.
 */
object PaymentProviderRegistry {

    val REGISTERED_APPS = listOf(
        // Vodacom M-Pesa
        RegisteredPaymentApp("M-Pesa", "com.vodacom.mpesa", PackageVerificationStatus.VERIFIED_PLAY_STORE, "Vodacom M-Pesa Tanzania"),
        RegisteredPaymentApp("M-Pesa", "tz.co.vodacom.mpesa", PackageVerificationStatus.PROVISIONAL_ALIAS, "Vodacom Alternate Package"),
        RegisteredPaymentApp("M-Pesa", "com.vodafone.vodapay", PackageVerificationStatus.PROVISIONAL_ALIAS, "VodaPay Enterprise"),
        RegisteredPaymentApp("M-Pesa", "com.mpesa.tz", PackageVerificationStatus.PROVISIONAL_ALIAS, "M-Pesa Legacy Package"),

        // Mixx by Yas (Tigo Pesa)
        RegisteredPaymentApp("Mixx by Yas", "tz.tigo.mfsapp", PackageVerificationStatus.VERIFIED_PLAY_STORE, "Tigo Pesa Tanzania"),
        RegisteredPaymentApp("Mixx by Yas", "com.yas.mixx", PackageVerificationStatus.PROVISIONAL_ALIAS, "Mixx by Yas App"),
        RegisteredPaymentApp("Mixx by Yas", "com.tigo.pesa.tz", PackageVerificationStatus.PROVISIONAL_ALIAS, "Tigo Pesa Legacy"),

        // Airtel Money
        RegisteredPaymentApp("Airtel Money", "com.airtel.africa.selfcare", PackageVerificationStatus.VERIFIED_PLAY_STORE, "My Airtel Africa (Tanzania)"),
        RegisteredPaymentApp("Airtel Money", "com.airtel.africa.money", PackageVerificationStatus.PROVISIONAL_ALIAS, "Airtel Money App"),

        // HaloPesa
        RegisteredPaymentApp("HaloPesa", "com.halopesa.eu", PackageVerificationStatus.VERIFIED_PLAY_STORE, "HaloPesa Official"),
        RegisteredPaymentApp("HaloPesa", "com.halotel.halopesa", PackageVerificationStatus.PROVISIONAL_ALIAS, "HaloPesa Alternate"),

        // CRDB Bank
        RegisteredPaymentApp("CRDB Bank", "com.crdb.simbanking", PackageVerificationStatus.VERIFIED_PLAY_STORE, "CRDB SimBanking"),
        RegisteredPaymentApp("CRDB Bank", "com.crdb.mobile", PackageVerificationStatus.PROVISIONAL_ALIAS, "CRDB Mobile"),

        // NMB Bank
        RegisteredPaymentApp("NMB Bank", "com.nmb.mkononi", PackageVerificationStatus.VERIFIED_PLAY_STORE, "NMB Mkononi Official"),
        RegisteredPaymentApp("NMB Bank", "com.nmb.mobile", PackageVerificationStatus.PROVISIONAL_ALIAS, "NMB Mobile"),
        RegisteredPaymentApp("NMB Bank", "com.nmb.direct", PackageVerificationStatus.PROVISIONAL_ALIAS, "NMB Direct")
    )

    private val AUTHORIZED_PACKAGES_SET: Set<String> = REGISTERED_APPS.map { it.packageName }.toSet()

    val FINANCIAL_SENDER_SHORTCODES = listOf(
        "M-PESA", "MPESA", "VODACOM", "MIXX", "TIGO PESA", "TIGOPESA", "TIGO",
        "AIRTELMONEY", "AIRTEL", "HALOPESA", "HALOTEL", "CRDB", "NMB"
    )

    private val BLOCKED_PERSONAL_APPS = setOf(
        "com.whatsapp",
        "com.whatsapp.w4b",
        "org.telegram.messenger",
        "org.telegram.messenger.web",
        "com.facebook.katana",
        "com.facebook.orca",
        "com.instagram.android",
        "com.snapchat.android",
        "com.twitter.android",
        "com.google.android.gm",
        "com.android.chrome",
        "com.Slack"
    )

    private val PERSONAL_PHONE_PATTERN = Regex("^\\+?\\d[\\d\\s\\-().]{5,}$")
    private val OUTGOING_TRANSFER_PATTERN = Regex(
        "\\b(Umetuma|Umefanya malipo|Umelipa|Umetoa|Imetumwa|You have sent|You paid|Debit of|Withdrawn)\\b",
        RegexOption.IGNORE_CASE
    )
    private val INCOMING_CREDIT_PATTERN = Regex(
        "\\b(Umepokea|Umelipwa|You have received|have received|Credit of|Imethibitishwa|Confirmed)\\b",
        RegexOption.IGNORE_CASE
    )

    fun isAuthorizedPackage(packageName: String): Boolean {
        return AUTHORIZED_PACKAGES_SET.contains(packageName)
    }

    fun isBlockedPersonalPackage(packageName: String): Boolean {
        return BLOCKED_PERSONAL_APPS.contains(packageName)
    }

    fun isPersonalPhoneSender(sender: String): Boolean {
        val trimmed = sender.trim()
        if (trimmed.isEmpty()) return true
        return PERSONAL_PHONE_PATTERN.matches(trimmed)
    }

    fun isFinancialShortcode(title: String, body: String): Boolean {
        val cleanTitle = title.trim()
        if (cleanTitle.isEmpty() || isPersonalPhoneSender(cleanTitle)) {
            return false
        }
        val matchesSender = FINANCIAL_SENDER_SHORTCODES.any { code ->
            cleanTitle.equals(code, ignoreCase = true) || cleanTitle.contains(code, ignoreCase = true)
        }
        if (!matchesSender) {
            return false
        }
        return !OUTGOING_TRANSFER_PATTERN.containsMatchIn(body)
    }

    fun isEligibleNotificationSource(packageName: String, title: String, body: String): Boolean {
        if (isBlockedPersonalPackage(packageName)) {
            return false
        }
        if (isAuthorizedPackage(packageName)) {
            return !OUTGOING_TRANSFER_PATTERN.containsMatchIn(body)
        }
        return isFinancialShortcode(title, body) && INCOMING_CREDIT_PATTERN.containsMatchIn(body)
    }

    fun getAppInfo(packageName: String): RegisteredPaymentApp? {
        return REGISTERED_APPS.find { it.packageName == packageName }
    }
}
