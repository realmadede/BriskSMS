package tz.co.brisksms.ui.settings

/**
 * Some phone makers stop background apps more aggressively than Android does. These are the usual
 * places to switch that off. Menu names differ between versions, so the steps say "usually".
 */
object BackgroundGuide {

    data class Guide(val maker: String, val steps: List<String>)

    fun forManufacturer(manufacturer: String): Guide {
        val name = manufacturer.trim().lowercase()
        return when {
            name == "samsung" -> Guide(
                "Samsung",
                listOf(
                    "Open Settings, Battery, Background usage limits.",
                    "Turn off Put unused apps to sleep.",
                    "Add BriskSMS to Never sleeping apps."
                )
            )
            name in setOf("xiaomi", "redmi", "poco") -> Guide(
                "Xiaomi",
                listOf(
                    "Open Settings, Apps, Manage apps, BriskSMS.",
                    "Turn on Autostart.",
                    "Open Battery saver and choose No restrictions."
                )
            )
            name in setOf("tecno", "infinix", "itel", "transsion") -> Guide(
                name.replaceFirstChar { it.uppercase() },
                listOf(
                    "Open Phone Master or Phone Manager, find Auto-start management and allow BriskSMS.",
                    "Open Settings, Battery, App battery management and set BriskSMS to No restrictions.",
                    "In the recent apps view, lock BriskSMS so it is not cleared."
                )
            )
            else -> Guide(
                "your phone",
                listOf(
                    "Open Battery optimization below and set BriskSMS to Don't optimize.",
                    "In your phone's battery settings, allow BriskSMS to run in the background."
                )
            )
        }
    }
}
