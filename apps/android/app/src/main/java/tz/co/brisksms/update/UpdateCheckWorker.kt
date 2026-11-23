package tz.co.brisksms.update

import android.content.Context
import android.net.ConnectivityManager
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import tz.co.brisksms.BuildConfig

/**
 * Direct build, every 12 hours: look for a newer release and, on an unmetered network (Wi-Fi), download and verify
 * it so it is ready for one tap. Then remind the owner by notification, at most once every 24 hours.
 * It never downloads over mobile data: customers pay for their bundles.
 */
class UpdateCheckWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        if (!BuildConfig.SELF_UPDATE) return Result.success()

        val connectivity = applicationContext.getSystemService(ConnectivityManager::class.java)
        val unmetered = connectivity?.isActiveNetworkMetered == false
        val state = UpdateEngine.get(applicationContext).refreshInBackground(allowDownload = unmetered)

        val (release, ready) = when (state) {
            is UpdateState.Available -> state.release to false
            is UpdateState.Ready -> state.release to true
            is UpdateState.Failed -> (state.release ?: return Result.success()) to false
            else -> return Result.success()
        }

        val reminder = UpdateReminder(applicationContext)
        if (reminder.notificationDue(release)) {
            UpdateNotifier.notify(applicationContext, release, ready)
            reminder.markNotified(release)
        }
        return Result.success()
    }
}
