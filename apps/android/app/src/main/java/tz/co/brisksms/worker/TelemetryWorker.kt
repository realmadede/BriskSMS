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
import org.json.JSONArray
import org.json.JSONObject
import tz.co.brisksms.core.network.BriskApiClient
import tz.co.brisksms.core.network.DeviceCommandAckPayload
import tz.co.brisksms.core.network.DeviceTelemetryRequest
import tz.co.brisksms.core.storage.KeystoreSecureStorage
import tz.co.brisksms.data.local.BriskDatabase
import tz.co.brisksms.messaging.PendingSmsJobResultStore

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
            // Flush any persisted outbound SMS job results from prior radio dispatch before reporting telemetry
            PendingSmsJobResultStore.flushPending(secureStorage, apiClient)

            val db = BriskDatabase.getInstance(applicationContext)
            val pendingEvidence = db.evidenceDao().countPending()
            val pendingDispatches = db.smsDispatchDao().countPending()

            val (batteryPct, isCharging) = getBatteryStatus()
            val networkType = getNetworkType()

            val pendingAcks = loadPendingAcks()
            val telemetry = DeviceTelemetryRequest(
                batteryPercentage = batteryPct,
                isCharging = isCharging,
                networkType = networkType,
                signalStrengthDbm = null,
                pendingOfflineCount = pendingEvidence + pendingDispatches,
                commandAcknowledgements = pendingAcks
            )

            val result = apiClient.sendTelemetry(telemetry)
            if (result.isSuccess) {
                val response = result.getOrNull()
                if (response != null) {
                    val remainingAcks = DeviceCommandProcessor.reconcilePendingAcks(pendingAcks, response.ackResults)
                    savePendingAcks(remainingAcks)
                    if (response.commands.isNotEmpty()) {
                        processRemoteCommands(response.commands, remainingAcks, db)
                    }
                }
                Log.i(TAG, "Reported device telemetry successfully. Battery: $batteryPct%, Net: $networkType")
                Result.success()
            } else {
                if (secureStorage.isRevoked) {
                    Log.w(TAG, "Device revoked by backend during telemetry; wiping local identity and halting retries.")
                    db.clearAllTables()
                    runCatching { tz.co.brisksms.security.KeystoreManager().deleteKey() }
                    androidx.work.WorkManager.getInstance(applicationContext).cancelAllWork()
                    return Result.failure()
                }
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
        pendingAcks: List<DeviceCommandAckPayload>,
        db: BriskDatabase
    ) {
        var currentPending = pendingAcks
        for (cmd in commands) {
            if (cmd.id.isBlank()) continue
            if (DeviceCommandProcessor.shouldSkipAlreadyPendingAck(cmd, currentPending)) {
                Log.i(TAG, "Skipping duplicate delivery for locally completed command [${cmd.id}] pending ACK.")
                continue
            }

            Log.i(TAG, "Processing remote fleet command: ${cmd.type} [${cmd.id}]")
            val ack = executeCommand(cmd, db) ?: continue

            val ackResult = apiClient.acknowledgeCommand(ack)
            if (!ackResult.accepted && ackResult.retryable && !secureStorage.isRevoked) {
                currentPending = DeviceCommandProcessor.mergePendingAck(currentPending, ack)
                savePendingAcks(currentPending)
            }
        }
    }

    private suspend fun executeCommand(
        cmd: tz.co.brisksms.core.network.DeviceCommandPayload,
        db: BriskDatabase
    ): DeviceCommandAckPayload? {
        return try {
            when (cmd.type) {
                "PAUSE_RELAY" -> {
                    secureStorage.isBulkMessagingEnabled = false
                    val stopIntent = Intent(applicationContext, tz.co.brisksms.messaging.service.SmsGateRelayService::class.java).apply {
                        action = tz.co.brisksms.messaging.service.SmsGateRelayService.ACTION_STOP
                    }
                    applicationContext.stopService(stopIntent)
                    Log.i(TAG, "Cellular SMS relay paused by remote command.")
                    DeviceCommandAckPayload(commandId = cmd.id, status = "ACKNOWLEDGED", leaseToken = cmd.leaseToken)
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
                    DeviceCommandAckPayload(commandId = cmd.id, status = "ACKNOWLEDGED", leaseToken = cmd.leaseToken)
                }
                "SWITCH_SIM" -> {
                    val rawSlot = if (cmd.payload != null && cmd.payload.has("simSlot")) cmd.payload.opt("simSlot") else null
                    val targetSlot = DeviceCommandProcessor.parseValidatedSimSlot(rawSlot)
                    if (targetSlot == null) {
                        val reason = "Invalid SWITCH_SIM payload: simSlot must be 1 or 2"
                        Log.w(TAG, reason)
                        DeviceCommandAckPayload(
                            commandId = cmd.id,
                            status = "FAILED",
                            leaseToken = cmd.leaseToken,
                            failureReason = reason
                        )
                    } else {
                        secureStorage.preferredSimSlot = targetSlot
                        Log.i(TAG, "Primary SIM preference switched to slot $targetSlot by remote command.")
                        DeviceCommandAckPayload(commandId = cmd.id, status = "ACKNOWLEDGED", leaseToken = cmd.leaseToken)
                    }
                }
                "WIPE_AND_REVOKE" -> {
                    Log.w(TAG, "Executing emergency WIPE_AND_REVOKE remote command.")
                    runCatching {
                        apiClient.acknowledgeCommand(
                            DeviceCommandAckPayload(
                                commandId = cmd.id,
                                status = "ACKNOWLEDGED",
                                leaseToken = cmd.leaseToken
                            )
                        )
                    }
                    runCatching {
                        applicationContext.stopService(
                            android.content.Intent(
                                applicationContext,
                                tz.co.brisksms.messaging.service.SmsGateRelayService::class.java
                            )
                        )
                    }
                    runCatching {
                        androidx.work.WorkManager.getInstance(applicationContext).cancelUniqueWork("BrisksmsTelemetry")
                        androidx.work.WorkManager.getInstance(applicationContext).cancelUniqueWork("BrisksmsEvidenceUpload")
                    }
                    secureStorage.clearRevokedIdentity()
                    secureStorage.pendingCommandAcksJson = null
                    secureStorage.pendingSmsJobResultsJson = null
                    db.clearAllTables()
                    try {
                        val km = tz.co.brisksms.security.KeystoreManager()
                        km.deleteKey()
                    } catch (e: Exception) {
                        Log.w(TAG, "Failed deleting Keystore key: ${e.message}")
                    }
                    null
                }
                else -> {
                    val reason = "Unsupported fleet command type: ${cmd.type}"
                    Log.w(TAG, reason)
                    DeviceCommandAckPayload(
                        commandId = cmd.id,
                        status = "FAILED",
                        leaseToken = cmd.leaseToken,
                        failureReason = reason
                    )
                }
            }
        } catch (e: Exception) {
            val reason = (e.message ?: "Command execution exception").take(255)
            Log.e(TAG, "Command [${cmd.id}] execution failed: $reason")
            DeviceCommandAckPayload(
                commandId = cmd.id,
                status = "FAILED",
                leaseToken = cmd.leaseToken,
                failureReason = reason
            )
        }
    }

    private fun loadPendingAcks(): List<DeviceCommandAckPayload> {
        val raw = secureStorage.pendingCommandAcksJson ?: return emptyList()
        return try {
            val arr = JSONArray(raw)
            val list = mutableListOf<DeviceCommandAckPayload>()
            for (i in 0 until arr.length()) {
                val obj = arr.getJSONObject(i)
                val cmdId = obj.optString("commandId", "")
                val status = obj.optString("status", "")
                if (cmdId.isNotBlank() && status.isNotBlank()) {
                    list.add(
                        DeviceCommandAckPayload(
                            commandId = cmdId,
                            status = status,
                            leaseToken = if (obj.isNull("leaseToken")) null else obj.optString("leaseToken", "").ifEmpty { null },
                            failureReason = if (obj.isNull("failureReason")) null else obj.optString("failureReason", "").ifEmpty { null }
                        )
                    )
                }
            }
            list
        } catch (_: Exception) {
            emptyList()
        }
    }

    private fun savePendingAcks(acks: List<DeviceCommandAckPayload>) {
        if (acks.isEmpty()) {
            secureStorage.pendingCommandAcksJson = null
            return
        }
        val arr = JSONArray()
        for (ack in acks) {
            arr.put(JSONObject().apply {
                put("commandId", ack.commandId)
                put("status", ack.status)
                if (ack.leaseToken != null) put("leaseToken", ack.leaseToken)
                if (ack.failureReason != null) put("failureReason", ack.failureReason)
            })
        }
        secureStorage.pendingCommandAcksJson = arr.toString()
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
