package tz.co.brisksms.worker

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import tz.co.brisksms.core.network.BriskApiClient
import tz.co.brisksms.core.network.DeviceTelemetryRequest
import tz.co.brisksms.core.storage.KeystoreSecureStorage
import tz.co.brisksms.data.local.BriskDatabase

/**
 * Shared Device Telemetry Worker
 * Collects operationally necessary hardware metrics (battery, charging, network type, signal strength,
 * and pending offline queue counts) and reports to POST /v1/devices/:id/telemetry.
 */
class TelemetryWorker(
    appContext: Context,
    workerParams: WorkerParameters
) : CoroutineWorker(appContext, workerParams) {

    companion object {
        private const val TAG = "TelemetryWorker"
    }

    private val secureStorage = KeystoreSecureStorage(applicationContext)
    private val apiClient = BriskApiClient(secureStorage)

    override suspend fun doWork(): Result {
        if (!secureStorage.isPaired || secureStorage.isRevoked) {
            Log.w(TAG, "Device not paired or revoked; skipping telemetry report.")
            return Result.failure()
        }

        return try {
            val db = BriskDatabase.getInstance(applicationContext)
            val pendingEvidence = db.evidenceDao().countPending()
            val pendingDispatches = db.smsDispatchDao().countPending()

            val (batteryPct, isCharging) = getBatteryStatus()
            val networkType = getNetworkType()

            val telemetry = DeviceTelemetryRequest(
                batteryPercentage = batteryPct,
                isCharging = isCharging,
                networkType = networkType,
                signalStrengthDbm = null,
                pendingOfflineCount = pendingEvidence + pendingDispatches
            )

            val result = apiClient.sendTelemetry(telemetry)
            if (result.isSuccess) {
                val response = result.getOrNull()
                if (response != null && response.commands.isNotEmpty()) {
                    processRemoteCommands(response.commands, db)
                }
                Log.i(TAG, "Reported device telemetry successfully. Battery: $batteryPct%, Net: $networkType")
                Result.success()
            } else {
                Log.w(TAG, "Telemetry upload reported error: ${result.exceptionOrNull()?.message}")
                Result.retry()
            }
        } catch (e: Exception) {
            Log.e(TAG, "Exception during telemetry collection: ${e.message}")
            Result.retry()
        }
    }

    private suspend fun processRemoteCommands(
        commands: List<tz.co.brisksms.core.network.DeviceCommandPayload>,
        db: BriskDatabase
    ) {
        for (cmd in commands) {
            Log.i(TAG, "Processing remote fleet command: ${cmd.type} [${cmd.id}]")
            when (cmd.type) {
                "PAUSE_RELAY" -> {
                    secureStorage.isBulkMessagingEnabled = false
                    val stopIntent = Intent(applicationContext, tz.co.brisksms.messaging.service.SmsGateRelayService::class.java).apply {
                        action = tz.co.brisksms.messaging.service.SmsGateRelayService.ACTION_STOP
                    }
                    applicationContext.stopService(stopIntent)
                    Log.i(TAG, "Cellular SMS relay paused by remote command.")
                }
                "RESUME_RELAY" -> {
                    secureStorage.isBulkMessagingEnabled = true
                    val startIntent = Intent(applicationContext, tz.co.brisksms.messaging.service.SmsGateRelayService::class.java).apply {
                        action = tz.co.brisksms.messaging.service.SmsGateRelayService.ACTION_START
                    }
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        applicationContext.startForegroundService(startIntent)
                    } else {
                        applicationContext.startService(startIntent)
                    }
                    Log.i(TAG, "Cellular SMS relay resumed by remote command.")
                }
                "SWITCH_SIM" -> {
                    val targetSlot = cmd.payload?.optInt("simSlot", 1) ?: 1
                    secureStorage.preferredSimSlot = targetSlot
                    Log.i(TAG, "Primary SIM preference switched to slot $targetSlot by remote command.")
                }
                "WIPE_AND_REVOKE" -> {
                    Log.w(TAG, "Executing emergency WIPE_AND_REVOKE remote command.")
                    secureStorage.isRevoked = true
                    secureStorage.isPaired = false
                    secureStorage.deviceToken = null
                    db.clearAllTables()
                    try {
                        val km = tz.co.brisksms.security.KeystoreManager()
                        km.deleteKey()
                    } catch (e: Exception) {
                        Log.w(TAG, "Failed deleting Keystore key: ${e.message}")
                    }
                }
            }
        }
    }

    private fun getBatteryStatus(): Pair<Int, Boolean> {
        return try {
            val ifilter = IntentFilter(Intent.ACTION_BATTERY_CHANGED)
            val batteryStatus = applicationContext.registerReceiver(null, ifilter)

            val level = batteryStatus?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
            val scale = batteryStatus?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
            val status = batteryStatus?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1

            val isCharging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
                    status == BatteryManager.BATTERY_STATUS_FULL

            val batteryPct = if (level >= 0 && scale > 0) {
                (level * 100 / scale.toFloat()).toInt()
            } else {
                100
            }

            Pair(batteryPct, isCharging)
        } catch (e: Exception) {
            Pair(100, false)
        }
    }

    private fun getNetworkType(): String {
        return try {
            val cm = applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
                ?: return "UNKNOWN"

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                val network = cm.activeNetwork ?: return "NONE"
                val capabilities = cm.getNetworkCapabilities(network) ?: return "NONE"

                when {
                    capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "WIFI"
                    capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "CELLULAR"
                    capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ETHERNET"
                    else -> "OTHER"
                }
            } else {
                @Suppress("DEPRECATION")
                val activeNetworkInfo = cm.activeNetworkInfo
                if (activeNetworkInfo == null || !activeNetworkInfo.isConnected) return "NONE"
                @Suppress("DEPRECATION")
                when (activeNetworkInfo.type) {
                    ConnectivityManager.TYPE_WIFI -> "WIFI"
                    ConnectivityManager.TYPE_MOBILE -> "CELLULAR"
                    else -> "OTHER"
                }
            }
        } catch (e: Exception) {
            "UNKNOWN"
        }
    }
}
