package tz.co.brisksms.worker

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import tz.co.brisksms.core.storage.KeystoreSecureStorage
import tz.co.brisksms.messaging.service.SmsGateRelayService
import java.util.concurrent.TimeUnit

/**
 * Re-schedules periodic telemetry and resumes cellular SMS relay cleanly after handset reboot.
 */
class BootCompletedReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent?) {
        if (intent?.action != Intent.ACTION_BOOT_COMPLETED) return

        val secureStorage = KeystoreSecureStorage(context.applicationContext)
        if (!secureStorage.isPaired || secureStorage.isRevoked) {
            return
        }

        val telemetryRequest = PeriodicWorkRequestBuilder<TelemetryWorker>(
            15, TimeUnit.MINUTES
        ).build()
        WorkManager.getInstance(context.applicationContext).enqueueUniquePeriodicWork(
            "BrisksmsTelemetry",
            ExistingPeriodicWorkPolicy.KEEP,
            telemetryRequest
        )

        if (secureStorage.isBulkMessagingEnabled) {
            val serviceIntent = Intent(context.applicationContext, SmsGateRelayService::class.java).apply {
                action = SmsGateRelayService.ACTION_START
            }
            runCatching {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.applicationContext.startForegroundService(serviceIntent)
                } else {
                    context.applicationContext.startService(serviceIntent)
                }
            }.onFailure { err ->
                Log.w("BootCompletedReceiver", "Unable to auto-start SMSGate service at boot: ${err.message}")
            }
        }
    }
}
