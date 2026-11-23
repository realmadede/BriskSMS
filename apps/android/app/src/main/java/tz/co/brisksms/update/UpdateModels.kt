package tz.co.brisksms.update

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.security.MessageDigest

data class AppRelease(
    val versionCode: Int,
    val versionName: String,
    val apkUrl: String,
    val sha256: String,
    val notes: String,
    /** The installed version is below the minimum the server still supports. */
    val required: Boolean = false
)

data class UpdateCheck(val updateAvailable: Boolean, val release: AppRelease?)

/** A failure whose message is safe to show to the user. */
class UpdateException(message: String) : IOException(message)

object UpdateRules {
    const val MAX_APK_BYTES = 150L * 1024 * 1024
    const val REMIND_EVERY_MILLIS = 24L * 60 * 60 * 1000
    private val SHA256_HEX = Regex("^[0-9a-f]{64}$")

    /**
     * Reads the GET /v1/app/releases/latest reply. The phone does not take the server's word that an
     * update exists: the release must be https, carry a SHA-256 and be newer than [currentVersionCode].
     */
    fun parseCheck(body: String, currentVersionCode: Int): UpdateCheck {
        try {
            val data = JsonParser.parseString(body).asJsonObject.getAsJsonObject("data")
            if (data.get("updateAvailable")?.asBoolean != true) return UpdateCheck(false, null)

            val r = data.getAsJsonObject("release")
            val release = AppRelease(
                versionCode = r.get("versionCode").asInt,
                versionName = r.get("versionName").asString,
                apkUrl = r.get("apkUrl").asString,
                sha256 = r.get("sha256").asString.lowercase(),
                notes = r.optString("notes"),
                required = data.get("required")?.asBoolean == true
            )
            if (release.versionCode <= currentVersionCode) return UpdateCheck(false, null)
            if (release.apkUrl.toHttpUrlOrNull()?.isHttps != true) throw UpdateException("The update link is not secure")
            if (!SHA256_HEX.matches(release.sha256)) throw UpdateException("The update has no valid checksum")

            return UpdateCheck(true, release)
        } catch (e: UpdateException) {
            throw e
        } catch (e: Exception) {
            throw UpdateException("Unexpected reply from the update server")
        }
    }

    /**
     * Whether the reminder notification should be posted now: once when a release is first seen, then at most
     * once every 24 hours until the owner updates. A required update does not make it more frequent.
     */
    fun notificationDue(lastNotifiedVersionCode: Int, lastNotifiedAtMillis: Long, release: AppRelease, nowMillis: Long): Boolean =
        lastNotifiedVersionCode != release.versionCode ||
            nowMillis - lastNotifiedAtMillis >= REMIND_EVERY_MILLIS ||
            lastNotifiedAtMillis > nowMillis

    /** Whether [file] is complete and has the published SHA-256, so a download made earlier can be reused. */
    fun fileMatches(file: File, expectedSha256: String): Boolean {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(32 * 1024)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        return toHex(digest.digest()) == expectedSha256.lowercase()
    }

    private fun toHex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }

    /**
     * Whether the update window should open now. "Not now" silences one release for 24 hours; a newer release,
     * a required update, or a clock set back past the snooze all open it straight away.
     */
    fun isDue(snoozedVersionCode: Int, snoozedUntilMillis: Long, release: AppRelease, nowMillis: Long): Boolean =
        release.required ||
            snoozedVersionCode != release.versionCode ||
            nowMillis >= snoozedUntilMillis ||
            snoozedUntilMillis - nowMillis > REMIND_EVERY_MILLIS

    /**
     * Streams [input] to [target] while hashing it, and deletes [target] unless the download is complete,
     * within [maxBytes], and matches [expectedSha256].
     */
    fun copyVerified(
        input: InputStream,
        expectedLength: Long,
        target: File,
        expectedSha256: String,
        onProgress: (Float) -> Unit = {},
        maxBytes: Long = MAX_APK_BYTES
    ) {
        if (expectedLength > maxBytes) throw UpdateException("The update is larger than expected")
        val digest = MessageDigest.getInstance("SHA-256")
        var total = 0L
        try {
            target.outputStream().use { out ->
                val buffer = ByteArray(32 * 1024)
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    total += read
                    if (total > maxBytes) throw UpdateException("The update is larger than expected")
                    digest.update(buffer, 0, read)
                    out.write(buffer, 0, read)
                    if (expectedLength > 0) onProgress(total.toFloat() / expectedLength)
                }
            }
            if (expectedLength > 0 && total != expectedLength) throw UpdateException("The download was cut short")
            if (toHex(digest.digest()) != expectedSha256.lowercase()) {
                throw UpdateException("The download does not match its checksum")
            }
        } catch (e: Throwable) {
            target.delete()
            throw e
        }
    }

    private fun JsonObject.optString(name: String): String =
        get(name)?.takeIf { !it.isJsonNull }?.asString.orEmpty()
}
