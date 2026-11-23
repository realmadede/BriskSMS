package tz.co.brisksms.ui.settings

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import tz.co.brisksms.BuildConfig
import tz.co.brisksms.core.storage.KeystoreSecureStorage
import tz.co.brisksms.data.local.BriskDatabase
import tz.co.brisksms.messaging.sim.SimManager

/**
 * A short text the owner can send to support. It holds settings and counts only: no tokens,
 * no message text, no phone numbers and no payment details.
 */
object SupportBundle {

    suspend fun build(context: Context): String {
        val storage = KeystoreSecureStorage(context)
        val db = BriskDatabase.getInstance(context)
        val power = context.getSystemService(Context.POWER_SERVICE) as PowerManager

        fun granted(permission: String) =
            ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

        val rows = listOf(
            "App" to "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE}), ${BuildConfig.FLAVOR}",
            "Phone" to "${Build.MANUFACTURER} ${Build.MODEL}, Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})",
            "Paired" to if (storage.isPaired) "yes" else "no",
            "Device ID" to (storage.deviceId ?: "none"),
            "Account type" to (storage.accountType ?: "unknown"),
            "Server" to (Uri.parse(storage.apiBaseUrl).host ?: "unknown"),
            "Gateway mode" to storage.gatewayMode,
            "Bulk messaging on" to if (storage.isBulkMessagingEnabled) "yes" else "no",
            "Active SIMs" to SimManager(context).getActiveSimSlots().size.toString(),
            "Send SMS permission" to if (granted(Manifest.permission.SEND_SMS)) "granted" else "missing",
            "Read phone state permission" to if (granted(Manifest.permission.READ_PHONE_STATE)) "granted" else "missing",
            "Receive SMS permission" to if (granted(Manifest.permission.RECEIVE_SMS)) "granted" else "missing",
            "Notification access" to if (NotificationManagerCompat.getEnabledListenerPackages(context).contains(context.packageName)) "on" else "off",
            "Battery optimization" to if (power.isIgnoringBatteryOptimizations(context.packageName)) "exempt" else "applies",
            "Payment texts waiting to upload" to db.evidenceDao().countPending().toString(),
            "Messages queued" to db.smsDispatchDao().countPending().toString(),
            "Messages in flight" to db.smsDispatchDao().countInFlight().toString()
        )
        return "BriskSMS diagnostics\n" + rows.joinToString("\n") { (name, value) -> "$name: $value" }
    }
}
