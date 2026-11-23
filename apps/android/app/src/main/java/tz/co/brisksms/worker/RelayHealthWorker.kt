package tz.co.brisksms.worker

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import tz.co.brisksms.MainActivity
import tz.co.brisksms.R
import tz.co.brisksms.core.storage.KeystoreSecureStorage
import tz.co.brisksms.data.local.BriskDatabase
import tz.co.brisksms.messaging.sim.SimManager

/**
 * Every 30 minutes, checks the phone's own queues and tells the owner when the relay has stopped
 * doing its job. It only reads local counts, so it works when the network is the problem.
 * One notification is updated in place and removed as soon as everything is healthy again.
 */
class RelayHealthWorker(
    appContext: Context,
    workerParams: WorkerParameters
) : CoroutineWorker(appContext, workerParams) {

    private companion object {
        const val CHANNEL_ID = "relay_alerts"
        const val NOTIFICATION_ID = 4108
    }

    override suspend fun doWork(): Result {
        val storage = KeystoreSecureStorage(applicationContext)
        if (!storage.isPaired) return Result.success()

        val db = BriskDatabase.getInstance(applicationContext)
        val now = System.currentTimeMillis()
        val canReadSimState = ContextCompat.checkSelfPermission(
            applicationContext, Manifest.permission.READ_PHONE_STATE
        ) == PackageManager.PERMISSION_GRANTED

        val problems = RelayHealth.problems(
            isRevoked = storage.isRevoked,
            bulkMessagingEnabled = storage.isBulkMessagingEnabled,
            simStateKnown = canReadSimState,
            activeSimCount = if (canReadSimState) SimManager(applicationContext).getActiveSimSlots().size else 0,
            queuedTooLong = db.smsDispatchDao().countQueuedBefore(now - RelayHealth.STUCK_AFTER_MS),
            uploadsStalled = db.evidenceDao().countPendingBefore(now - RelayHealth.UPLOAD_STALLED_AFTER_MS)
        )

        val manager = NotificationManagerCompat.from(applicationContext)
        if (problems.isEmpty()) {
            manager.cancel(NOTIFICATION_ID)
        } else {
            notify(manager, problems)
        }
        return Result.success()
    }

    private fun notify(manager: NotificationManagerCompat, problems: List<String>) {
        if (!manager.areNotificationsEnabled()) return

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Relay alerts", NotificationManager.IMPORTANCE_DEFAULT).apply {
                    description = "Tells you when this phone has stopped relaying payments or messages."
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
            .setContentTitle("BriskSMS needs attention")
            .setContentText(problems.first())
            .setStyle(NotificationCompat.BigTextStyle().bigText(problems.joinToString("\n")))
            .setContentIntent(open)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .build()
        try {
            manager.notify(NOTIFICATION_ID, notification)
        } catch (_: SecurityException) {
            // Notification permission was revoked between the check and the post: nothing to alert with.
        }
    }
}
