package tz.co.brisksms.messaging.service

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import tz.co.brisksms.core.network.BriskApiClient
import tz.co.brisksms.core.storage.KeystoreSecureStorage
import tz.co.brisksms.data.local.BriskDatabase
import tz.co.brisksms.messaging.OutboundSmsJobCoordinator
import tz.co.brisksms.messaging.PendingSmsJobResultStore
import tz.co.brisksms.messaging.SimSelectionOutcome
import tz.co.brisksms.messaging.SimSlotCapability
import tz.co.brisksms.messaging.data.DispatchState
import tz.co.brisksms.messaging.data.SmsDispatchDao
import tz.co.brisksms.messaging.data.SmsDispatchEntity
import tz.co.brisksms.messaging.dispatcher.DispatchOutcome
import tz.co.brisksms.messaging.dispatcher.SmsDispatcher
import tz.co.brisksms.messaging.sim.SimManager
import java.time.Instant

/**
 * Android Foreground Cellular Gateway Relay Service (SMSGate Compatible)
 * Runs as a foreground service maintaining carrier connectivity and executing outbound dispatches.
 * Supports GatewayMode.MANAGED_GATEWAY (Private VPS behind Cloudflare) & GatewayMode.EXTERNAL_RELAY.
 */
class SmsGateRelayService : Service() {

    companion object {
        private const val TAG = "SmsGateRelayService"
        private const val NOTIFICATION_ID = 2001
        private const val CHANNEL_ID = "brisksms_cellular_gateway"
        private const val DEFAULT_DISPATCH_PACING_MS = 1500L // Internal engineering default delay between dispatches
        const val ACTION_START = "tz.co.brisksms.messaging.START_GATEWAY"
        const val ACTION_STOP = "tz.co.brisksms.messaging.STOP_GATEWAY"
    }

    private val serviceScope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private var relayJob: Job? = null

    private lateinit var secureStorage: KeystoreSecureStorage
    private lateinit var apiClient: BriskApiClient
    private lateinit var simManager: SimManager
    private lateinit var smsDispatcher: SmsDispatcher

    private val sentReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val dispatchId = intent?.getStringExtra(SmsDispatcher.EXTRA_DISPATCH_ID) ?: return
            val resultCode = resultCode

            serviceScope.launch {
                val db = BriskDatabase.getInstance(applicationContext)
                val dao = db.smsDispatchDao()
                val existing = dao.findById(dispatchId)
                val carrierTimestamp = Instant.now().toString()
                if (resultCode == Activity.RESULT_OK) {
                    Log.i(TAG, "Carrier ACK: SMS [$dispatchId] successfully submitted to tower.")
                    dao.updateStatus(dispatchId, DispatchState.SUBMITTED.name)
                    if (existing?.jobId != null && existing.leaseToken != null) {
                        val report = OutboundSmsJobCoordinator.buildSubmittedReport(
                            jobId = existing.jobId,
                            leaseToken = existing.leaseToken,
                            simSlot = existing.simSlot,
                            carrierTimestamp = carrierTimestamp
                        )
                        PendingSmsJobResultStore.submitOrPersist(secureStorage, apiClient, report)
                    }
                } else {
                    val errorMsg = "Carrier transmission failed with radio error code $resultCode"
                    Log.w(TAG, "Carrier NACK: SMS [$dispatchId]: $errorMsg")
                    dao.markFailed(dispatchId, errorMsg)
                    if (existing?.jobId != null && existing.leaseToken != null) {
                        val report = OutboundSmsJobCoordinator.buildRadioFailureReport(
                            jobId = existing.jobId,
                            leaseToken = existing.leaseToken,
                            simSlot = existing.simSlot,
                            radioResultCode = resultCode,
                            errorMessage = errorMsg
                        )
                        PendingSmsJobResultStore.submitOrPersist(secureStorage, apiClient, report)
                    }
                }
            }
        }
    }

    private val deliveryReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val dispatchId = intent?.getStringExtra(SmsDispatcher.EXTRA_DISPATCH_ID) ?: return
            serviceScope.launch {
                val db = BriskDatabase.getInstance(applicationContext)
                val dao = db.smsDispatchDao()
                val existing = dao.findById(dispatchId)
                Log.i(TAG, "Delivery Receipt: SMS [$dispatchId] delivered to recipient handset.")
                dao.updateStatus(dispatchId, DispatchState.DELIVERED.name)
                if (existing?.jobId != null && existing.leaseToken != null) {
                    val report = OutboundSmsJobCoordinator.buildDeliveredReport(
                        jobId = existing.jobId,
                        leaseToken = existing.leaseToken,
                        simSlot = existing.simSlot,
                        carrierTimestamp = Instant.now().toString()
                    )
                    PendingSmsJobResultStore.submitOrPersist(secureStorage, apiClient, report)
                }
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        secureStorage = KeystoreSecureStorage(applicationContext)
        apiClient = BriskApiClient(secureStorage)
        simManager = SimManager(applicationContext)
        smsDispatcher = SmsDispatcher(applicationContext, simManager)

        createNotificationChannel()

        val filterSent = IntentFilter(SmsDispatcher.ACTION_SMS_SENT)
        val filterDelivered = IntentFilter(SmsDispatcher.ACTION_SMS_DELIVERED)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(sentReceiver, filterSent, RECEIVER_NOT_EXPORTED)
            registerReceiver(deliveryReceiver, filterDelivered, RECEIVER_NOT_EXPORTED)
        } else {
            registerReceiver(sentReceiver, filterSent)
            registerReceiver(deliveryReceiver, filterDelivered)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopRelay()
                stopSelf()
                return START_NOT_STICKY
            }
            else -> {
                startRelayForeground()
            }
        }
        return START_STICKY
    }

    private fun startRelayForeground() {
        if (!secureStorage.isBulkMessagingEnabled || secureStorage.isRevoked) {
            Log.w(TAG, "Bulk messaging is disabled or device is revoked. Stopping relay service.")
            stopSelf()
            return
        }

        val notification = buildGatewayNotification()
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
                )
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
        } catch (e: Exception) {
            Log.e(TAG, "Unable to promote SmsGateRelayService to foreground: ${e.message}", e)
            stopSelf()
            return
        }

        if (relayJob?.isActive != true) {
            relayJob = serviceScope.launch {
                runRelayLoop()
            }
        }
    }

    private suspend fun runRelayLoop() {
        Log.i(TAG, "Starting SMSGate cellular relay loop for [${secureStorage.gatewayMode}]...")
        val db = BriskDatabase.getInstance(applicationContext)
        val dao = db.smsDispatchDao()

        try {
            while (serviceScope.isActive) {
                try {
                    if (secureStorage.isRevoked || !secureStorage.isBulkMessagingEnabled) {
                        Log.w(TAG, "Relay terminated: device revoked or product entitlement disabled.")
                        break
                    }

                    // 1. Flush durable encrypted job result reports BEFORE acquiring/sending new jobs
                    PendingSmsJobResultStore.flushPending(secureStorage, apiClient)

                    // 2. Acquire eligible outbound jobs from backend when paired & active
                    if (secureStorage.isPaired && !secureStorage.isRevoked && secureStorage.isBulkMessagingEnabled) {
                        acquireAndQueueRemoteJobs(dao)
                    }

                    // 3. Process local QUEUED dispatches through the 2-step /dispatching gate
                    val pending = dao.getPendingDispatches(limit = 10)
                    for (dispatch in pending) {
                        if (secureStorage.isRevoked || !secureStorage.isBulkMessagingEnabled) {
                            break
                        }
                        executeGuardedDispatch(dispatch, dao)
                        delay(DEFAULT_DISPATCH_PACING_MS) // Internal engineering delay between consecutive dispatches
                    }

                    delay(5000) // Queue poll interval
                } catch (e: Exception) {
                    Log.e(TAG, "Exception in relay loop: ${e.message}")
                    delay(10000)
                }
            }
        } finally {
            if (secureStorage.isRevoked || !secureStorage.isBulkMessagingEnabled) {
                stopSelf()
            }
        }
    }

    private suspend fun acquireAndQueueRemoteJobs(dao: SmsDispatchDao) {
        val startOfDay = smsDispatcher.startOfTodayMillis()
        val activeSims = simManager.getActiveSimSlots()
        val simCapabilities = activeSims.map { slot ->
            SimSlotCapability(
                simNumber = slot.simNumber,
                isReady = slot.isReady,
                sentTodayCount = dao.countSlotSentSince(slot.simNumber, startOfDay)
            )
        }
        val availableSimNumbers = simCapabilities.filter { it.isReady }.map { it.simNumber }
        if (availableSimNumbers.isEmpty()) {
            return
        }

        val acquireResult = apiClient.acquireOutboundSmsJobs(
            limit = 5,
            leaseSeconds = 60,
            availableSimSlots = availableSimNumbers
        )
        val acquired = acquireResult.getOrNull() ?: return
        if (!acquired.relayEnabled) {
            Log.w(TAG, "Backend reported relayEnabled=false; disabling bulk messaging relay.")
            secureStorage.isBulkMessagingEnabled = false
            return
        }

        val pendingResultsSnapshot = PendingSmsJobResultStore.snapshot(secureStorage)
        for (job in acquired.jobs) {
            when (val validation = OutboundSmsJobCoordinator.validateAcquiredJob(job)) {
                is tz.co.brisksms.messaging.JobValidationResult.Invalid -> {
                    Log.w(TAG, "Invalid outbound SMS job [${job.id}]: ${validation.reason}")
                    if (job.id.isNotBlank() && job.leaseToken.isNotBlank()) {
                        val failReport = OutboundSmsJobCoordinator.buildPreRadioFailureReport(
                            jobId = job.id,
                            leaseToken = job.leaseToken,
                            failureCode = validation.failureCode,
                            errorMessage = validation.reason
                        )
                        PendingSmsJobResultStore.submitOrPersist(secureStorage, apiClient, failReport)
                    }
                    continue
                }
                is tz.co.brisksms.messaging.JobValidationResult.Valid -> Unit
            }

            val existingByJob = dao.findByJobId(job.id)
            val idempKey = job.idempotencyKey?.takeIf { it.isNotBlank() } ?: "smsgate_job_${job.id}"
            val existingByKey = dao.findByIdempotencyKey(idempKey)

            if (OutboundSmsJobCoordinator.shouldSkipAcquiredJob(job, existingByJob, existingByKey, pendingResultsSnapshot)) {
                Log.w(TAG, "Skipping duplicate re-acquired SMS job [${job.id}] already handled locally.")
                continue
            }

            val slotSelection = OutboundSmsJobCoordinator.selectDispatchSimSlot(
                requestedSlot = job.simSlot,
                preferredDeviceSlot = secureStorage.preferredSimSlot,
                activeSlots = simCapabilities,
                dailyCapPerSim = SmsDispatcher.DEFAULT_SIM_DAILY_CAP
            )

            when (slotSelection) {
                is SimSelectionOutcome.Unavailable -> {
                    val failReport = OutboundSmsJobCoordinator.buildPreRadioFailureReport(
                        jobId = job.id,
                        leaseToken = job.leaseToken,
                        failureCode = slotSelection.failureCode,
                        errorMessage = slotSelection.reason
                    )
                    PendingSmsJobResultStore.submitOrPersist(secureStorage, apiClient, failReport)
                }
                is SimSelectionOutcome.Selected -> {
                    val entity = OutboundSmsJobCoordinator.toLocalDispatchEntity(job, slotSelection.simSlot)
                    dao.insert(entity)
                }
            }
        }
    }

    private suspend fun executeGuardedDispatch(dispatch: SmsDispatchEntity, dao: SmsDispatchDao) {
        val jobId = dispatch.jobId
        val leaseToken = dispatch.leaseToken

        if (jobId != null && leaseToken != null) {
            val gateResult = apiClient.markOutboundSmsDispatching(
                jobId = jobId,
                leaseToken = leaseToken,
                simSlot = dispatch.simSlot
            )
            if (!OutboundSmsJobCoordinator.canInvokeSmsManager(
                    dispatchingResult = gateResult,
                    relayEnabled = secureStorage.isBulkMessagingEnabled,
                    deviceRevoked = secureStorage.isRevoked
                )
            ) {
                if (!gateResult.retryable) {
                    val reason = gateResult.errorMessage ?: gateResult.errorCode ?: "Server rejected /dispatching gate"
                    Log.w(TAG, "Aborting dispatch for job [$jobId] before SmsManager: $reason")
                    dao.markFailed(dispatch.id, reason)
                } else {
                    Log.w(TAG, "Transient error confirming /dispatching for job [$jobId]: ${gateResult.errorCode}; skipping SmsManager.")
                }
                return
            }

            when (val outcome = smsDispatcher.dispatchMessage(dispatch, dao)) {
                is DispatchOutcome.Failed -> {
                    val isPreRadio = outcome.reason.contains("Missing SEND_SMS") || outcome.reason.contains("absent") || outcome.reason.contains("daily")
                    val report = if (isPreRadio) {
                        OutboundSmsJobCoordinator.buildPreRadioFailureReport(
                            jobId = jobId,
                            leaseToken = leaseToken,
                            failureCode = "ANDROID_DISPATCH_PRECHECK_FAILED",
                            errorMessage = outcome.reason,
                            simSlot = dispatch.simSlot
                        )
                    } else {
                        OutboundSmsJobCoordinator.buildRadioFailureReport(
                            jobId = jobId,
                            leaseToken = leaseToken,
                            simSlot = dispatch.simSlot,
                            radioResultCode = -1,
                            errorMessage = outcome.reason
                        )
                    }
                    PendingSmsJobResultStore.submitOrPersist(secureStorage, apiClient, report)
                }
                is DispatchOutcome.Submitted, is DispatchOutcome.DuplicateIgnored -> Unit
            }
            return
        }

        // Legacy local-only Room queue item
        smsDispatcher.dispatchMessage(dispatch, dao)
    }

    private fun stopRelay() {
        relayJob?.cancel()
        relayJob = null
    }

    override fun onDestroy() {
        super.onDestroy()
        stopRelay()
        serviceScope.cancel()
        try {
            unregisterReceiver(sentReceiver)
            unregisterReceiver(deliveryReceiver)
        } catch (e: Exception) {
            // Already unregistered
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "BriskSMS Cellular Gateway",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Monitors cellular SMS dispatch for BriskSMS SMSGate relay"
                setShowBadge(false)
            }
            val manager = getSystemService(NotificationManager::class.java)
            manager?.createNotificationChannel(channel)
        }
    }

    private fun buildGatewayNotification(): Notification {
        val simSlots = simManager.getActiveSimSlots()
        val carrierSummary = if (simSlots.isNotEmpty()) {
            simSlots.joinToString(", ") { "SIM ${it.simNumber}: ${it.carrierName}" }
        } else {
            "No active SIM cards"
        }

        val modeLabel = if (secureStorage.gatewayMode == "MANAGED_GATEWAY") "VPS (Cloudflare)" else "External Relay"

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("BriskSMS Cellular Gateway")
            .setContentText("$carrierSummary | Mode: $modeLabel")
            .setSmallIcon(tz.co.brisksms.R.drawable.ic_brisk_notification)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }
}
