package tz.co.brisksms.ui.health

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import tz.co.brisksms.core.network.BriskApiClient
import tz.co.brisksms.core.network.DeviceTelemetryRequest
import tz.co.brisksms.core.storage.KeystoreSecureStorage
import tz.co.brisksms.data.local.BriskDatabase
import tz.co.brisksms.security.KeystoreManager
import tz.co.brisksms.BuildConfig
import tz.co.brisksms.R
import tz.co.brisksms.payment.CaptureCounters
import tz.co.brisksms.payment.CaptureSource
import tz.co.brisksms.payment.CaptureStats
import tz.co.brisksms.ui.components.*
import tz.co.brisksms.ui.theme.BriskColors
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
fun DeviceHealthScreen() {
    val context = LocalContext.current
    val coroutineScope = rememberCoroutineScope()
    val secureStorage = remember { KeystoreSecureStorage(context) }
    val apiClient = remember { BriskApiClient(secureStorage) }
    val keystoreManager = remember { KeystoreManager() }
    val isHardwareBacked = remember { keystoreManager.isHardwareBacked() }

    var batteryPct by remember { mutableStateOf(100) }
    var isCharging by remember { mutableStateOf(false) }
    var networkType by remember { mutableStateOf("Detecting") }
    var dbSizeBytes by remember { mutableStateOf(0L) }
    var queueDepth by remember { mutableStateOf(0) }
    var lastSyncTime by remember { mutableStateOf("Not sent yet") }
    var isReporting by remember { mutableStateOf(false) }
    var reportFeedback by remember { mutableStateOf<String?>(null) }
    var isReportError by remember { mutableStateOf(false) }
    var smsStats by remember { mutableStateOf<CaptureStats?>(null) }
    var notificationStats by remember { mutableStateOf<CaptureStats?>(null) }

    fun refreshHealth() {
        val ifilter = IntentFilter(Intent.ACTION_BATTERY_CHANGED)
        val batteryStatus = context.registerReceiver(null, ifilter)
        val level = batteryStatus?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = batteryStatus?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
        val status = batteryStatus?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1

        isCharging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
                status == BatteryManager.BATTERY_STATUS_FULL
        batteryPct = if (level >= 0 && scale > 0) (level * 100 / scale.toFloat()).toInt() else 100

        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        networkType = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && cm != null) {
            val network = cm.activeNetwork
            val cap = cm.getNetworkCapabilities(network)
            when {
                cap?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true -> "Wi-Fi"
                cap?.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) == true -> "Mobile data"
                else -> "No network"
            }
        } else {
            "Connected"
        }

        coroutineScope.launch {
            withContext(Dispatchers.IO) {
                val dbFile = context.getDatabasePath(BriskDatabase.DB_NAME)
                val walFile = java.io.File("${dbFile.absolutePath}-wal")
                dbSizeBytes = (if (dbFile.exists()) dbFile.length() else 0L) +
                    (if (walFile.exists()) walFile.length() else 0L)

                val db = BriskDatabase.getInstance(context)
                val p1 = db.evidenceDao().countPending()
                val p2 = db.smsDispatchDao().countPending()
                queueDepth = p1 + p2
            }
        }
    }

    LaunchedEffect(Unit) {
        refreshHealth()
        smsStats = CaptureCounters.stats(context, CaptureSource.SMS)
        notificationStats = CaptureCounters.stats(context, CaptureSource.NOTIFICATION)
    }

    val isBatteryLow = batteryPct < 20 && !isCharging

    val formattedSize = if (dbSizeBytes > 1024 * 1024) {
        "${dbSizeBytes / (1024 * 1024)} MB"
    } else {
        "${dbSizeBytes / 1024} KB"
    }

    CollapsingScreen(
        title = "Device health",
        subtitle = "Battery, network, storage and key security on this phone"
    ) {
        // Battery warning if low
        if (isBatteryLow) {
            BriskCard(modifier = Modifier.fillMaxWidth()) {
                Row(verticalAlignment = Alignment.Top) {
                    Icon(
                        painter = painterResource(R.drawable.ic_triangle_alert),
                        contentDescription = null,
                        tint = BriskColors.StatusRejected,
                        modifier = Modifier.size(20.dp)
                    )
                    Spacer(modifier = Modifier.width(12.dp))
                    Text(
                        text = "Battery at $batteryPct% and unplugged. Connect to power so the relay keeps running in the background.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = BriskColors.textPrimary()
                    )
                }
            }
            Spacer(modifier = Modifier.height(16.dp))
        }

        // What the payment filter has done on this phone (counts only, never message text)
        SectionLabel("Payment capture")
        CaptureCard("Payment texts (SMS)", smsStats, visible = BuildConfig.SMS_PAYMENT_CAPTURE)
        if (BuildConfig.SMS_PAYMENT_CAPTURE) Spacer(modifier = Modifier.height(12.dp))
        CaptureCard("Messages-app notifications", notificationStats, visible = true)

        Spacer(modifier = Modifier.height(24.dp))

        // Hardware keystore
        SectionLabel("Key security")
        BriskCard(
            modifier = Modifier.fillMaxWidth(),
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 4.dp)
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 44.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = "Keystore",
                    style = MaterialTheme.typography.bodyMedium,
                    color = BriskColors.textSecondary(),
                    modifier = Modifier.weight(1f)
                )
                StatusTag(
                    kind = if (isHardwareBacked) StatusKind.Positive else StatusKind.Review,
                    text = if (isHardwareBacked) "Hardware (TEE)" else "Standard"
                )
            }
            HairlineDivider()
            KeyValueRow("Signing key", "EC P-256 · SHA256withECDSA", mono = true)
            HairlineDivider()
            KeyValueRow("Local storage", "AES-256-GCM", mono = true)
        }

        Spacer(modifier = Modifier.height(24.dp))

        // Live status
        SectionLabel("Status")
        BriskCard(
            modifier = Modifier.fillMaxWidth(),
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 4.dp)
        ) {
            KeyValueRow(
                label = "Battery",
                value = "$batteryPct%, ${if (isCharging) "charging" else "on battery"}",
                valueColor = if (isBatteryLow) BriskColors.negativeInk() else BriskColors.textPrimary()
            )
            HairlineDivider()
            KeyValueRow("Network", networkType)
            HairlineDivider()
            KeyValueRow("Local database", formattedSize)
            HairlineDivider()
            KeyValueRow("Waiting to upload", "%,d %s".format(queueDepth, if (queueDepth == 1) "record" else "records"))
            HairlineDivider()
            KeyValueRow("Last heartbeat", lastSyncTime)
        }

        if (reportFeedback != null) {
            Row(
                modifier = Modifier.padding(top = 12.dp),
                verticalAlignment = Alignment.Top
            ) {
                Icon(
                    painter = painterResource(if (isReportError) R.drawable.ic_circle_x else R.drawable.ic_circle_check),
                    contentDescription = null,
                    tint = if (isReportError) BriskColors.StatusRejected else BriskColors.StatusVerified,
                    modifier = Modifier
                        .padding(top = 1.dp)
                        .size(16.dp)
                )
                Spacer(modifier = Modifier.width(8.dp))
                Text(
                    text = reportFeedback ?: "",
                    style = MaterialTheme.typography.bodySmall,
                    color = BriskColors.textPrimary()
                )
            }
        }

        Spacer(modifier = Modifier.height(24.dp))

        PrimaryPillButton(
            text = "Send heartbeat",
            icon = R.drawable.ic_activity,
            loading = isReporting,
            onClick = {
                isReporting = true
                reportFeedback = null
                isReportError = false
                coroutineScope.launch {
                    refreshHealth()
                    val req = DeviceTelemetryRequest(
                        batteryPercentage = batteryPct,
                        isCharging = isCharging,
                        networkType = if (networkType.contains("Wi-Fi")) "WIFI" else "CELLULAR",
                        signalStrengthDbm = null,
                        pendingOfflineCount = queueDepth
                    )
                    val res = withContext(Dispatchers.IO) {
                        apiClient.sendTelemetry(req)
                    }
                    if (res.isSuccess) {
                        runCatching {
                            val wm = androidx.work.WorkManager.getInstance(context)
                            wm.enqueue(androidx.work.OneTimeWorkRequestBuilder<tz.co.brisksms.worker.TelemetryWorker>().build())
                            wm.enqueue(androidx.work.OneTimeWorkRequestBuilder<tz.co.brisksms.worker.EvidenceUploadWorker>().build())
                        }
                        val fmt = SimpleDateFormat("HH:mm:ss", Locale.getDefault())
                        lastSyncTime = fmt.format(Date())
                        isReportError = false
                        reportFeedback = "Heartbeat sent and background sync started"
                    } else {
                        isReportError = true
                        reportFeedback = "Heartbeat failed: ${res.exceptionOrNull()?.message}"
                    }
                    isReporting = false
                }
            }
        )
    }
}

@Composable
private fun CaptureCard(title: String, stats: CaptureStats?, visible: Boolean) {
    if (!visible || stats == null) return
    BriskCard(
        modifier = Modifier.fillMaxWidth(),
        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 4.dp)
    ) {
        Text(
            text = title,
            style = MaterialTheme.typography.titleSmall,
            color = BriskColors.textPrimary(),
            modifier = Modifier.padding(vertical = 12.dp)
        )
        HairlineDivider()
        KeyValueRow("Kept as payments", "%,d".format(stats.kept))
        HairlineDivider()
        KeyValueRow("Dropped: not a payment", "%,d".format(stats.notAPayment))
        HairlineDivider()
        KeyValueRow("Dropped: money going out", "%,d".format(stats.outgoingMoney))
        if (title.contains("SMS")) {
            HairlineDivider()
            KeyValueRow("Dropped: personal numbers", "%,d".format(stats.personalNumber))
            HairlineDivider()
            KeyValueRow("Dropped: other senders", "%,d".format(stats.otherSender))
        }
        HairlineDivider()
        KeyValueRow(
            "Last kept",
            stats.lastKeptAt?.let { SimpleDateFormat("d MMM, HH:mm", Locale.getDefault()).format(Date(it)) } ?: "None yet"
        )
    }
}
