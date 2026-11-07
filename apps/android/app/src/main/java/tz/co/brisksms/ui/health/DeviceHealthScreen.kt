package tz.co.brisksms.ui.health

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import tz.co.brisksms.core.network.BriskApiClient
import tz.co.brisksms.core.network.DeviceTelemetryRequest
import tz.co.brisksms.core.storage.KeystoreSecureStorage
import tz.co.brisksms.data.local.BriskDatabase
import tz.co.brisksms.security.KeystoreManager
import tz.co.brisksms.ui.theme.BriskColors
import tz.co.brisksms.ui.theme.BriskShapes
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
    var networkType by remember { mutableStateOf("DETECTING") }
    var dbSizeBytes by remember { mutableStateOf(0L) }
    var queueDepth by remember { mutableStateOf(0) }
    var lastSyncTime by remember { mutableStateOf("Pending report") }
    var isReporting by remember { mutableStateOf(false) }
    var reportFeedback by remember { mutableStateOf<String?>(null) }

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
                cap?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true -> "Wi-Fi Connected"
                cap?.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) == true -> "Cellular Mobile Data"
                else -> "No Network"
            }
        } else {
            "Network Available"
        }

        coroutineScope.launch {
            withContext(Dispatchers.IO) {
                val dbFile = context.getDatabasePath("brisksms.db")
                dbSizeBytes = if (dbFile.exists()) dbFile.length() else 0L

                val db = BriskDatabase.getInstance(context)
                val p1 = db.evidenceDao().countPending()
                val p2 = db.smsDispatchDao().countPending()
                queueDepth = p1 + p2
            }
        }
    }

    LaunchedEffect(Unit) {
        refreshHealth()
    }

    val isBatteryLow = batteryPct < 20 && !isCharging

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(BriskColors.CanvasBaseLight)
            .padding(20.dp)
            .verticalScroll(rememberScrollState())
    ) {
        // Top Header
        Text(
            text = "Device Health & Telemetry",
            fontSize = 20.sp,
            fontWeight = FontWeight.Bold,
            color = BriskColors.TextPrimaryLight
        )
        Text(
            text = "Hardware state, cryptographic isolation, and local storage",
            fontSize = 12.sp,
            color = BriskColors.TextSecondaryLight
        )

        Spacer(modifier = Modifier.height(16.dp))

        // Battery Warning Banner if low
        if (isBatteryLow) {
            Card(
                shape = BriskShapes.medium,
                colors = CardDefaults.cardColors(containerColor = BriskColors.StatusRejected.copy(alpha = 0.1f)),
                modifier = Modifier.fillMaxWidth()
            ) {
                Row(
                    modifier = Modifier.padding(14.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        text = "Warning: Battery level is critical ($batteryPct%) and device is unplugged. Connect to power to ensure uninterrupted background gateway relays.",
                        fontSize = 12.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = BriskColors.StatusRejected
                    )
                }
            }
            Spacer(modifier = Modifier.height(14.dp))
        }

        // Hardware Keystore Card
        Card(
            shape = BriskShapes.large,
            colors = CardDefaults.cardColors(containerColor = BriskColors.SurfaceSolidLight),
            modifier = Modifier.fillMaxWidth()
        ) {
            Column(modifier = Modifier.padding(16.dp)) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        text = "CRYPTOGRAPHIC ISOLATION",
                        fontSize = 10.sp,
                        fontWeight = FontWeight.Bold,
                        color = BriskColors.TextTertiaryLight
                    )
                    Surface(
                        shape = BriskShapes.extraLarge,
                        color = if (isHardwareBacked) BriskColors.StatusVerified.copy(alpha = 0.15f) else BriskColors.StatusReview.copy(alpha = 0.15f)
                    ) {
                        Text(
                            text = if (isHardwareBacked) "HARDWARE SECURE (TEE)" else "STANDARD KEYSTORE",
                            fontSize = 10.sp,
                            fontWeight = FontWeight.Bold,
                            color = if (isHardwareBacked) BriskColors.StatusVerified else BriskColors.StatusReview,
                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp)
                        )
                    }
                }
                Spacer(modifier = Modifier.height(6.dp))
                Text(
                    text = "Asymmetric Key: EC P-256 (SHA256withECDSA)\nLocal Storage: AES-256-GCM Hardware-Backed Master Key",
                    fontSize = 12.sp,
                    color = BriskColors.TextSecondaryLight
                )
            }
        }

        Spacer(modifier = Modifier.height(14.dp))

        // Hardware Status Details
        Card(
            shape = BriskShapes.large,
            colors = CardDefaults.cardColors(containerColor = Color.White),
            modifier = Modifier.fillMaxWidth()
        ) {
            Column(modifier = Modifier.padding(16.dp)) {
                // Battery Row
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Text(text = "Battery Status", fontSize = 13.sp, color = BriskColors.TextSecondaryLight)
                    Text(
                        text = "$batteryPct% ${if (isCharging) "(Charging)" else "(Discharging)"}",
                        fontSize = 13.sp,
                        fontWeight = FontWeight.Bold,
                        color = if (isBatteryLow) BriskColors.StatusRejected else BriskColors.TextPrimaryLight
                    )
                }

                Divider(modifier = Modifier.padding(vertical = 10.dp), color = BriskColors.BorderHairlineLight)

                // Network Row
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Text(text = "Network Interface", fontSize = 13.sp, color = BriskColors.TextSecondaryLight)
                    Text(
                        text = networkType,
                        fontSize = 13.sp,
                        fontWeight = FontWeight.Bold,
                        color = BriskColors.TextPrimaryLight
                    )
                }

                Divider(modifier = Modifier.padding(vertical = 10.dp), color = BriskColors.BorderHairlineLight)

                // Storage Row
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Text(text = "Local SQLite Size", fontSize = 13.sp, color = BriskColors.TextSecondaryLight)
                    val formattedSize = if (dbSizeBytes > 1024 * 1024) {
                        "${dbSizeBytes / (1024 * 1024)} MB"
                    } else {
                        "${dbSizeBytes / 1024} KB"
                    }
                    Text(
                        text = formattedSize,
                        fontSize = 13.sp,
                        fontWeight = FontWeight.Bold,
                        color = BriskColors.TextPrimaryLight
                    )
                }

                Divider(modifier = Modifier.padding(vertical = 10.dp), color = BriskColors.BorderHairlineLight)

                // Queue Depth
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Text(text = "Total Pending Queue", fontSize = 13.sp, color = BriskColors.TextSecondaryLight)
                    Text(
                        text = "$queueDepth records",
                        fontSize = 13.sp,
                        fontWeight = FontWeight.Bold,
                        color = if (queueDepth > 0) BriskColors.StatusReview else BriskColors.StatusVerified
                    )
                }

                Divider(modifier = Modifier.padding(vertical = 10.dp), color = BriskColors.BorderHairlineLight)

                // Telemetry Timestamp
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Text(text = "Last Telemetry Report", fontSize = 13.sp, color = BriskColors.TextSecondaryLight)
                    Text(
                        text = lastSyncTime,
                        fontSize = 13.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = BriskColors.TextPrimaryLight
                    )
                }
            }
        }

        if (reportFeedback != null) {
            Text(
                text = reportFeedback ?: "",
                color = BriskColors.StatusVerified,
                fontSize = 12.sp,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.padding(top = 10.dp)
            )
        }

        Spacer(modifier = Modifier.height(20.dp))

        // Force Telemetry Button
        Button(
            onClick = {
                isReporting = true
                reportFeedback = null
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
                        val fmt = SimpleDateFormat("HH:mm:ss", Locale.getDefault())
                        lastSyncTime = fmt.format(Date())
                        reportFeedback = "Telemetry successfully delivered to backend"
                    } else {
                        reportFeedback = "Upload error: ${res.exceptionOrNull()?.message}"
                    }
                    isReporting = false
                }
            },
            enabled = !isReporting,
            shape = BriskShapes.extraLarge,
            colors = ButtonDefaults.buttonColors(
                containerColor = BriskColors.ContrastPill,
                contentColor = Color.White
            ),
            modifier = Modifier
                .fillMaxWidth()
                .height(48.dp)
        ) {
            if (isReporting) {
                CircularProgressIndicator(color = Color.White, modifier = Modifier.size(20.dp))
            } else {
                Text(text = "Send Health Heartbeat Now", fontWeight = FontWeight.SemiBold)
            }
        }
    }
}
