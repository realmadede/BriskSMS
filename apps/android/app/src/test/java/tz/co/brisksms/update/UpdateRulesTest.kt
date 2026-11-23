package tz.co.brisksms.update

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.security.MessageDigest

class UpdateRulesTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private val sha = "a".repeat(64)

    private fun reply(
        available: Boolean = true,
        code: Int = 5,
        url: String = "https://downloads.brisksms.app/brisksms-direct-1.4.0.apk",
        checksum: String = sha,
        required: Boolean = false
    ) = """{"success":true,"data":{"updateAvailable":$available,"required":$required,"release":
        {"versionCode":$code,"versionName":"1.4.0","apkUrl":"$url","sha256":"${checksum.uppercase()}","notes":"Faster sync"}}}"""

    private fun sha256(bytes: ByteArray) =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    private fun expectUpdateError(block: () -> Unit): UpdateException {
        try {
            block()
        } catch (e: UpdateException) {
            return e
        }
        fail("expected UpdateException")
        throw IllegalStateException()
    }

    @Test
    fun readsANewerReleaseAndNormalisesTheChecksum() {
        val check = UpdateRules.parseCheck(reply(required = true), currentVersionCode = 4)
        assertTrue(check.updateAvailable)
        assertTrue(check.release?.required == true)
        assertEquals(5, check.release?.versionCode)
        assertEquals(sha, check.release?.sha256)
        assertEquals("Faster sync", check.release?.notes)
    }

    @Test
    fun reportsUpToDateWhenTheServerSaysSoOrOffersNothingNewer() {
        assertNull(UpdateRules.parseCheck("""{"data":{"updateAvailable":false,"required":false,"release":null}}""", 4).release)
        // The server claims an update, but the phone is already on that version: trust the phone's own comparison.
        assertNull(UpdateRules.parseCheck(reply(code = 4), currentVersionCode = 4).release)
        assertFalse(UpdateRules.parseCheck(reply(code = 3), currentVersionCode = 4).updateAvailable)
    }

    private val release = AppRelease(5, "1.4.0", "https://downloads.brisksms.app/a.apk", sha, "Faster sync")
    private val hour = 60L * 60 * 1000

    @Test
    fun opensTheUpdateWindowWhenNothingWasSnoozed() {
        assertTrue(UpdateRules.isDue(0, 0L, release, nowMillis = 1_000L))
    }

    @Test
    fun staysQuietFor24HoursAfterNotNowThenOpensAgain() {
        val snoozedAt = 10_000_000L
        val until = snoozedAt + UpdateRules.REMIND_EVERY_MILLIS
        assertFalse(UpdateRules.isDue(5, until, release, nowMillis = snoozedAt + 1 * hour))
        assertFalse(UpdateRules.isDue(5, until, release, nowMillis = until - 1))
        assertTrue(UpdateRules.isDue(5, until, release, nowMillis = until))
        assertTrue(UpdateRules.isDue(5, until, release, nowMillis = until + 3 * hour))
    }

    @Test
    fun aNewerReleaseOrARequiredUpdateOpensTheWindowImmediately() {
        val until = 10_000_000L + UpdateRules.REMIND_EVERY_MILLIS
        assertTrue(UpdateRules.isDue(4, until, release, nowMillis = 10_000_000L + hour))
        assertTrue(UpdateRules.isDue(5, until, release.copy(required = true), nowMillis = 10_000_000L + hour))
    }

    @Test
    fun remindsByNotificationOnceThenAtMostEvery24Hours() {
        val first = 10_000_000L
        assertTrue(UpdateRules.notificationDue(0, 0L, release, nowMillis = first))
        assertFalse(UpdateRules.notificationDue(5, first, release, nowMillis = first + 12 * hour))
        assertTrue(UpdateRules.notificationDue(5, first, release, nowMillis = first + 24 * hour))
        // A newer release is announced straight away, a required one is not announced more often.
        assertTrue(UpdateRules.notificationDue(4, first, release, nowMillis = first + hour))
        assertFalse(UpdateRules.notificationDue(5, first, release.copy(required = true), nowMillis = first + hour))
        // A clock set back must not silence the reminder.
        assertTrue(UpdateRules.notificationDue(5, first, release, nowMillis = first - 48 * hour))
    }

    @Test
    fun reusesAnEarlierDownloadOnlyWhenItsChecksumMatches() {
        val bytes = ByteArray(5000) { (it % 13).toByte() }
        val file = tmp.newFile("earlier.apk").apply { writeBytes(bytes) }
        assertTrue(UpdateRules.fileMatches(file, sha256(bytes).uppercase()))
        assertFalse(UpdateRules.fileMatches(file, sha))
    }

    @Test
    fun aClockSetBackDoesNotSilenceTheWindowForLonger() {
        val until = 10_000_000L + UpdateRules.REMIND_EVERY_MILLIS
        // Phone clock moved back two days: the snooze would otherwise last three days.
        assertTrue(UpdateRules.isDue(5, until, release, nowMillis = 10_000_000L - 48 * hour))
    }

    @Test
    fun refusesAnInsecureOrChecksumlessRelease() {
        expectUpdateError { UpdateRules.parseCheck(reply(url = "http://downloads.brisksms.app/a.apk"), 1) }
        expectUpdateError { UpdateRules.parseCheck(reply(url = "ftp://downloads.brisksms.app/a.apk"), 1) }
        expectUpdateError { UpdateRules.parseCheck(reply(checksum = "abc"), 1) }
    }

    @Test
    fun refusesAReplyItCannotRead() {
        expectUpdateError { UpdateRules.parseCheck("<html>502 Bad Gateway</html>", 1) }
        expectUpdateError { UpdateRules.parseCheck("""{"success":true}""", 1) }
    }

    @Test
    fun keepsAFileWhoseChecksumMatchesAndReportsProgress() {
        val bytes = ByteArray(100_000) { (it % 251).toByte() }
        val target = tmp.newFile("ok.apk")
        val progress = mutableListOf<Float>()

        UpdateRules.copyVerified(ByteArrayInputStream(bytes), bytes.size.toLong(), target, sha256(bytes).uppercase(), { progress += it })

        assertTrue(target.exists())
        assertEquals(bytes.size.toLong(), target.length())
        assertEquals(1f, progress.last(), 0.0001f)
    }

    @Test
    fun deletesAFileWhoseChecksumDoesNotMatch() {
        val bytes = ByteArray(1000) { 7 }
        val target = tmp.newFile("bad.apk")
        val e = expectUpdateError { UpdateRules.copyVerified(ByteArrayInputStream(bytes), bytes.size.toLong(), target, sha) }
        assertEquals("The download does not match its checksum", e.message)
        assertFalse(target.exists())
    }

    @Test
    fun deletesAFileThatWasCutShort() {
        val bytes = ByteArray(1000) { 7 }
        val target = tmp.newFile("short.apk")
        val e = expectUpdateError { UpdateRules.copyVerified(ByteArrayInputStream(bytes), 2000L, target, sha256(bytes)) }
        assertEquals("The download was cut short", e.message)
        assertFalse(target.exists())
    }

    @Test
    fun refusesADownloadLargerThanTheLimitBeforeAndWhileReading() {
        val target = tmp.newFile("big.apk")
        expectUpdateError { UpdateRules.copyVerified(ByteArrayInputStream(ByteArray(1)), 10_001L, target, sha, maxBytes = 10_000L) }

        // A server that lies about (or omits) the length is still stopped by the running total.
        val endless = object : InputStream() {
            override fun read(): Int = 1
            override fun read(b: ByteArray, off: Int, len: Int): Int = len
        }
        expectUpdateError { UpdateRules.copyVerified(endless, -1L, target, sha, maxBytes = 10_000L) }
        assertFalse(target.exists())
    }
}
