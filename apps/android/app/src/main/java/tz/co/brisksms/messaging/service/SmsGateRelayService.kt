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
import tz.co.brisksms.core.storage.KeystoreSecureStorage
import tz.co.brisksms.data.local.BriskDatabase
import tz.co.brisksms.messaging.data.DispatchState
import tz.co.brisksms.messaging.dispatcher.SmsDispatcher
import tz.co.brisksms.messaging.sim.SimManager

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
        const val ACTION_START = "tz.co.brisksms.messaging.START_GATEWAY"
        const val ACTION_STOP = "tz.co.brisksms.messaging.STOP_GATEWAY"
    }

    private val serviceScope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private var relayJob: Job? = null

    private lateinit var secureStorage: KeystoreSecureStorage
    private lateinit var simManager: SimManager
    private lateinit var smsDispatcher: SmsDispatcher

    private val sentReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val dispatchId = intent?.getStringExtra(SmsDispatcher.EXTRA_DISPATCH_ID) ?: return
            val resultCode = resultCode

            serviceScope.launch {
                val db = BriskDatabase.getInstance(applicationContext)
                val dao = db.smsDispatchDao()
                if (resultCode == Activity.RESULT_OK) {
                    Log.i(TAG, "Carrier ACK: SMS [$dispatchId] successfully submitted to tower.")
                    dao.updateStatus(dispatchId, DispatchState.SUBMITTED.name)
                } else {
                    val errorMsg = "Carrier transmission failed with radio error code $resultCode"
                    Log.w(TAG, "Carrier NACK: SMS [$dispatchId]: $errorMsg")
                    dao.markFailed(dispatchId, errorMsg)
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
                Log.i(TAG, "Delivery Receipt: SMS [$dispatchId] delivered to recipient handset.")
                dao.updateStatus(dispatchId, DispatchState.DELIVERED.name)
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        secureStorage = KeystoreSecureStorage(applicationContext)
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
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
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

        while (serviceScope.isActive) {
            try {
                if (secureStorage.isRevoked || !secureStorage.isBulkMessagingEnabled) {
                    Log.w(TAG, "Relay terminated: device revoked or product entitlement disabled.")
                    break
                }

                // Process local queue
                val pending = dao.getPendingDispatches(limit = 10)
                for (dispatch in pending) {
                    smsDispatcher.dispatchMessage(dispatch, dao)
                    delay(1500) // TCRA & carrier pacing delay between consecutive dispatches
                }

                delay(5000) // Queue poll interval
            } catch (e: Exception) {
                Log.e(TAG, "Exception in relay loop: ${e.message}")
                delay(10000)
            }
        }
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
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }
}
