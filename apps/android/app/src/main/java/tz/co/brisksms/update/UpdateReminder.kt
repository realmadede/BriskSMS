package tz.co.brisksms.update

import android.content.Context

/** Remembers on this phone which release the owner pushed back with "Not now", and until when. */
class UpdateReminder(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("brisksms_update", Context.MODE_PRIVATE)

    fun isDue(release: AppRelease, nowMillis: Long = System.currentTimeMillis()): Boolean =
        UpdateRules.isDue(prefs.getInt(KEY_VERSION_CODE, 0), prefs.getLong(KEY_UNTIL, 0L), release, nowMillis)

    fun snooze(release: AppRelease, nowMillis: Long = System.currentTimeMillis()) {
        prefs.edit()
            .putInt(KEY_VERSION_CODE, release.versionCode)
            .putLong(KEY_UNTIL, nowMillis + UpdateRules.REMIND_EVERY_MILLIS)
            .apply()
    }

    /** The owner opened the app from the reminder notification, so show the window even if it was snoozed. */
    fun clearSnooze() {
        prefs.edit().remove(KEY_VERSION_CODE).remove(KEY_UNTIL).apply()
    }

    fun notificationDue(release: AppRelease, nowMillis: Long = System.currentTimeMillis()): Boolean =
        UpdateRules.notificationDue(prefs.getInt(KEY_NOTIFIED_CODE, 0), prefs.getLong(KEY_NOTIFIED_AT, 0L), release, nowMillis)

    fun markNotified(release: AppRelease, nowMillis: Long = System.currentTimeMillis()) {
        prefs.edit().putInt(KEY_NOTIFIED_CODE, release.versionCode).putLong(KEY_NOTIFIED_AT, nowMillis).apply()
    }

    private companion object {
        const val KEY_VERSION_CODE = "snoozed_version_code"
        const val KEY_UNTIL = "snoozed_until_millis"
        const val KEY_NOTIFIED_CODE = "notified_version_code"
        const val KEY_NOTIFIED_AT = "notified_at_millis"
    }
}
