package tz.co.brisksms.update

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.provider.Settings
import androidx.core.content.FileProvider
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import tz.co.brisksms.BuildConfig
import tz.co.brisksms.core.storage.KeystoreSecureStorage
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

sealed interface UpdateState {
    object Idle : UpdateState
    object Checking : UpdateState
    object UpToDate : UpdateState
    data class Available(val release: AppRelease) : UpdateState
    data class Downloading(val release: AppRelease, val progress: Float) : UpdateState
    data class Ready(val release: AppRelease, val file: File) : UpdateState
    /** [release] is set when the failed step was the download, so the user can retry it. */
    data class Failed(val message: String, val release: AppRelease? = null) : UpdateState
}

enum class InstallLaunch { Started, NeedsPermission }

/**
 * Self-update for the direct-download build: check the API, download the APK, verify it, hand it to the system
 * installer. Android itself refuses an APK that is not signed with this app's key, and it always asks the owner
 * to confirm the install. Lives for the whole process so a download survives leaving the Settings screen, and
 * so the background worker and the screens share one state.
 *
 * It uses its own HTTP client on purpose: the API client attaches the device token to every request,
 * and that token must never be sent to the download host.
 */
class UpdateEngine private constructor(private val appContext: Context) {

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val _state = MutableStateFlow<UpdateState>(UpdateState.Idle)
    val state: StateFlow<UpdateState> = _state.asStateFlow()

    /** One check or download at a time, whether it was started by a screen or by the background worker. */
    private val running = AtomicBoolean(false)
    @Volatile private var lastCheckAt = 0L

    /**
     * Quiet check for when the app opens or comes back to the front: at most once an hour, and a failure leaves
     * the state as it was instead of showing an error nobody asked for.
     */
    fun autoCheck() {
        if (running.get() || _state.value is UpdateState.Ready) return
        if (lastCheckAt != 0L && SystemClock.elapsedRealtime() - lastCheckAt < AUTO_CHECK_INTERVAL_MS) return
        scope.launch { checkNow(silent = true) }
    }

    fun check() {
        scope.launch { checkNow(silent = false) }
    }

    fun download() {
        val release = when (val s = _state.value) {
            is UpdateState.Available -> s.release
            is UpdateState.Failed -> s.release ?: return
            else -> return
        }
        scope.launch { downloadNow(release) }
    }

    /**
     * For the background worker: look for a release and, when [allowDownload] (the phone is on an unmetered
     * network), fetch and verify it too, so the reminder can say it is ready to install.
     */
    suspend fun refreshInBackground(allowDownload: Boolean): UpdateState {
        val checked = checkNow(silent = true)
        if (allowDownload && checked is UpdateState.Available) downloadNow(checked.release)
        return _state.value
    }

    private suspend fun checkNow(silent: Boolean): UpdateState {
        if (!running.compareAndSet(false, true)) return _state.value
        val before = _state.value
        try {
            lastCheckAt = SystemClock.elapsedRealtime()
            if (!silent) _state.value = UpdateState.Checking
            val result = withContext(Dispatchers.IO) { fetchLatest() }
            _state.value = if (silent && result is UpdateState.Failed) before else result
        } finally {
            running.set(false)
        }
        return _state.value
    }

    private fun fetchLatest(): UpdateState = try {
        val base = KeystoreSecureStorage(appContext).apiBaseUrl
        val request = Request.Builder()
            .url("$base/v1/app/releases/latest?versionCode=${BuildConfig.VERSION_CODE}")
            .header("Accept", "application/json")
            .build()
        client.newCall(request).execute().use { response ->
            val body = response.body?.string().orEmpty()
            if (!response.isSuccessful) throw UpdateException("The update server replied ${response.code}")
            val release = UpdateRules.parseCheck(body, BuildConfig.VERSION_CODE).release
            if (release == null) {
                UpdateNotifier.cancel(appContext)
                UpdateState.UpToDate
            } else {
                verifiedFileOrNull(release)?.let { UpdateState.Ready(release, it) } ?: UpdateState.Available(release)
            }
        }
    } catch (e: UpdateException) {
        UpdateState.Failed(e.message ?: "The update check failed")
    } catch (e: IOException) {
        UpdateState.Failed("Could not reach the update server. Check the connection and try again.")
    } catch (e: IllegalArgumentException) {
        UpdateState.Failed("The update server address is not valid")
    }

    private suspend fun downloadNow(release: AppRelease) {
        if (!running.compareAndSet(false, true)) return
        try {
            _state.value = UpdateState.Downloading(release, 0f)
            _state.value = withContext(Dispatchers.IO) { fetchApk(release) }
        } finally {
            running.set(false)
        }
    }

    private fun fetchApk(release: AppRelease): UpdateState {
        val target = apkFile(release).apply { parentFile?.mkdirs() }
        target.parentFile?.listFiles()?.filter { it != target }?.forEach { it.delete() }
        verifiedFileOrNull(release)?.let { return UpdateState.Ready(release, it) }

        return try {
            client.newCall(Request.Builder().url(release.apkUrl).build()).execute().use { response ->
                val body = response.body
                if (!response.isSuccessful || body == null) throw UpdateException("The download failed (${response.code})")
                var lastShown = 0f
                UpdateRules.copyVerified(
                    input = body.byteStream(),
                    expectedLength = body.contentLength(),
                    target = target,
                    expectedSha256 = release.sha256,
                    onProgress = { p ->
                        if (p - lastShown >= 0.01f) {
                            lastShown = p
                            _state.value = UpdateState.Downloading(release, p)
                        }
                    }
                )
            }
            verifyPackage(target, release)
            UpdateState.Ready(release, target)
        } catch (e: UpdateException) {
            target.delete()
            UpdateState.Failed(e.message ?: "The download failed", release)
        } catch (e: IOException) {
            target.delete()
            UpdateState.Failed("The download was interrupted. Check the connection and try again.", release)
        } catch (e: IllegalArgumentException) {
            UpdateState.Failed("The download address is not valid", release)
        }
    }

    /** An earlier download of this release, kept only if it is still complete, matches the checksum and is this app. */
    private fun verifiedFileOrNull(release: AppRelease): File? {
        val file = apkFile(release)
        if (!file.isFile) return null
        return try {
            if (!UpdateRules.fileMatches(file, release.sha256)) throw UpdateException("checksum")
            verifyPackage(file, release)
            file
        } catch (e: Exception) {
            file.delete()
            null
        }
    }

    private fun apkFile(release: AppRelease) =
        File(File(appContext.cacheDir, "updates"), "brisksms-${release.versionCode}.apk")

    /** Opens the system installer, or the "install unknown apps" screen when this app is not yet allowed to. */
    fun install(): InstallLaunch {
        val ready = _state.value as? UpdateState.Ready ?: return InstallLaunch.Started
        if (!ready.file.isFile) {
            _state.value = UpdateState.Failed("The downloaded update is no longer on this phone. Download it again.", ready.release)
            return InstallLaunch.Started
        }
        if (!appContext.packageManager.canRequestPackageInstalls()) {
            appContext.startActivity(
                Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${appContext.packageName}"))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            )
            return InstallLaunch.NeedsPermission
        }
        val uri = FileProvider.getUriForFile(appContext, "${appContext.packageName}.updates", ready.file)
        appContext.startActivity(
            Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        )
        return InstallLaunch.Started
    }

    /** The checksum proves the file is the one we published; this proves it is this app at the promised version. */
    private fun verifyPackage(file: File, release: AppRelease) {
        val info = appContext.packageManager.getPackageArchiveInfo(file.path, 0)
            ?: throw UpdateException("The downloaded file is not an app package")
        val code = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode else info.versionCode.toLong()
        if (info.packageName != appContext.packageName || code != release.versionCode.toLong()) {
            throw UpdateException("The downloaded file is not the expected update")
        }
    }

    companion object {
        private const val AUTO_CHECK_INTERVAL_MS = 60L * 60 * 1000

        @Volatile private var instance: UpdateEngine? = null

        fun get(context: Context): UpdateEngine =
            instance ?: synchronized(this) {
                instance ?: UpdateEngine(context.applicationContext).also { instance = it }
            }
    }
}
