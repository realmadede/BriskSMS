package tz.co.brisksms.update

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import tz.co.brisksms.MainActivity
import tz.co.brisksms.R

/** The reminder shown when an update is waiting. Tapping it opens the app with the update window. */
object UpdateNotifier {
    const val EXTRA_SHOW_UPDATE = "tz.co.brisksms.SHOW_UPDATE"
    private const val CHANNEL_ID = "app_updates"
    private const val NOTIFICATION_ID = 4107

    fun notify(context: Context, release: AppRelease, ready: Boolean) {
        val manager = NotificationManagerCompat.from(context)
        if (!manager.areNotificationsEnabled()) return

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "App updates", NotificationManager.IMPORTANCE_DEFAULT).apply {
                    description = "Tells you when a new version of BriskSMS is available."
                }
            )
        }

        val open = PendingIntent.getActivity(
            context,
            0,
            Intent(context, MainActivity::class.java)
                .putExtra(EXTRA_SHOW_UPDATE, true)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val title = if (ready) "BriskSMS ${release.versionName} is ready to install" else "BriskSMS ${release.versionName} is available"
        val summary = if (ready) "Tap to install. It is already downloaded and checked." else "Tap to see what is new and update."
        val details = release.notes.ifBlank { summary }

        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_brisk_notification)
            .setContentTitle(title)
            .setContentText(if (release.notes.isBlank()) summary else release.notes.lineSequence().first())
            .setStyle(NotificationCompat.BigTextStyle().bigText(details))
            .setContentIntent(open)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_RECOMMENDATION)
            .build()
        try {
            manager.notify(NOTIFICATION_ID, notification)
        } catch (_: SecurityException) {
            // Notification permission was revoked between the check and the post: nothing to remind with.
        }
    }

    fun cancel(context: Context) {
        NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID)
    }
}
