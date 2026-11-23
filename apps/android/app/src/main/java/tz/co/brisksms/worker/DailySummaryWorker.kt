package tz.co.brisksms.worker

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.time.ZonedDateTime
import java.util.concurrent.TimeUnit
import tz.co.brisksms.MainActivity
import tz.co.brisksms.R
import tz.co.brisksms.core.storage.KeystoreSecureStorage
import tz.co.brisksms.data.local.BriskDatabase

/**
 * Once a day at 18:00, if the owner turned it on in Settings, says how much this phone handled today.
 * Reads local counts only. Stays silent on a day with nothing to report.
 */
class DailySummaryWorker(
    appContext: Context,
    workerParams: WorkerParameters
) : CoroutineWorker(appContext, workerParams) {

    companion object {
        private const val WORK_NAME = "BrisksmsDailySummary"
        private const val CHANNEL_ID = "daily_summary"
        private const val NOTIFICATION_ID = 4109

        /** Turns the daily summary on (first run at the next 18:00) or off. */
        fun schedule(context: Context, enabled: Boolean) {
            val work = WorkManager.getInstance(context)
            if (!enabled) {
                work.cancelUniqueWork(WORK_NAME)
                return
            }
            val request = PeriodicWorkRequestBuilder<DailySummaryWorker>(24, TimeUnit.HOURS)
                .setInitialDelay(DailySummary.delayUntilNext(ZonedDateTime.now()).toMillis(), TimeUnit.MILLISECONDS)
                .build()
            work.enqueueUniquePeriodicWork(WORK_NAME, ExistingPeriodicWorkPolicy.UPDATE, request)
        }
    }

    override suspend fun doWork(): Result {
        val storage = KeystoreSecureStorage(applicationContext)
        if (!storage.isPaired || storage.isRevoked || !storage.isDailySummaryEnabled) return Result.success()

        val db = BriskDatabase.getInstance(applicationContext)
        val startOfToday = ZonedDateTime.now().toLocalDate().atStartOfDay(ZonedDateTime.now().zone).toInstant().toEpochMilli()
        val lines = DailySummary.lines(
            captured = db.evidenceDao().countCollectedSince(startOfToday),
            uploaded = db.evidenceDao().countUploadedSince(startOfToday),
            sent = db.smsDispatchDao().countSentSince(startOfToday),
            delivered = db.smsDispatchDao().countDeliveredSince(startOfToday)
        )
        if (lines.isNotEmpty()) notify(lines)
        return Result.success()
    }

    private fun notify(lines: List<String>) {
        val manager = NotificationManagerCompat.from(applicationContext)
        if (!manager.areNotificationsEnabled()) return

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Daily summary", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "Once a day, how many payment texts and messages this phone handled."
                }
            )
        }

        val open = PendingIntent.getActivity(
            applicationContext,
            0,
            Intent(applicationContext, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification = NotificationCompat.Builder(applicationContext, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_brisk_notification)
            .setContentTitle("Today on this phone")
            .setContentText(lines.first())
            .setStyle(NotificationCompat.BigTextStyle().bigText(lines.joinToString("\n")))
            .setContentIntent(open)
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .build()
        try {
            manager.notify(NOTIFICATION_ID, notification)
        } catch (_: SecurityException) {
            // Notification permission was revoked between the check and the post: nothing to say it with.
        }
    }
}
