package tz.co.brisksms.ui.overview

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
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import tz.co.brisksms.core.storage.KeystoreSecureStorage
import tz.co.brisksms.data.local.BriskDatabase
import tz.co.brisksms.ui.theme.BriskColors
import tz.co.brisksms.ui.theme.BriskShapes
import tz.co.brisksms.worker.EvidenceUploadWorker
import tz.co.brisksms.worker.TelemetryWorker
import java.util.Calendar

@Composable
fun OverviewScreen(
    onNavigateToPayment: () -> Unit,
    onNavigateToMessaging: () -> Unit
) {
    val context = LocalContext.current
    val coroutineScope = rememberCoroutineScope()
    val secureStorage = remember { KeystoreSecureStorage(context) }
    val db = remember { BriskDatabase.getInstance(context) }

    var collectedToday by remember { mutableStateOf(0) }
    var uploadedToday by remember { mutableStateOf(0) }
    var smsDispatchedToday by remember { mutableStateOf(0) }
    var smsDeliveredToday by remember { mutableStateOf(0) }
    var isSyncing by remember { mutableStateOf(false) }

    val startOfDay = remember {
        val cal = Calendar.getInstance().apply {
            set(Calendar.HOUR_OF_DAY, 0)
            set(Calendar.MINUTE, 0)
            set(Calendar.SECOND, 0)
            set(Calendar.MILLISECOND, 0)
        }
        cal.timeInMillis
    }

    LaunchedEffect(Unit) {
        withContext(Dispatchers.IO) {
            collectedToday = db.evidenceDao().countCollectedSince(startOfDay)
            uploadedToday = db.evidenceDao().countUploadedSince(startOfDay)
            smsDispatchedToday = db.smsDispatchDao().countSentSince(startOfDay)
            smsDeliveredToday = db.smsDispatchDao().countDeliveredSince(startOfDay)
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(BriskColors.CanvasBaseLight)
            .padding(20.dp)
            .verticalScroll(rememberScrollState())
    ) {
        // Top Header
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = 8.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column {
                Text(
                    text = "BriskSMS Companion",
                    fontSize = 20.sp,
                    fontWeight = FontWeight.Bold,
                    color = BriskColors.TextPrimaryLight
                )
                Text(
                    text = "${Build.MANUFACTURER} ${Build.MODEL}",
                    fontSize = 12.sp,
                    color = BriskColors.TextSecondaryLight
                )
            }

            Surface(
                shape = BriskShapes.extraLarge,
                color = if (!secureStorage.isRevoked && secureStorage.isPaired)
                    BriskColors.StatusVerified.copy(alpha = 0.15f)
                else
                    BriskColors.StatusRejected.copy(alpha = 0.15f)
            ) {
                Row(
                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp)
                ) {
                    Box(
                        modifier = Modifier
                            .size(6.dp)
                            .background(
                                if (!secureStorage.isRevoked && secureStorage.isPaired)
                                    BriskColors.StatusVerified
                                else
                                    BriskColors.StatusRejected,
                                CircleShape
                            )
                    )
                    Text(
                        text = if (secureStorage.isRevoked) "REVOKED" else if (secureStorage.isPaired) "ACTIVE" else "OFFLINE",
                        fontSize = 11.sp,
                        fontWeight = FontWeight.Bold,
                        color = if (!secureStorage.isRevoked && secureStorage.isPaired)
                            BriskColors.StatusVerified
                        else
                            BriskColors.StatusRejected
                    )
                }
            }
        }

        Spacer(modifier = Modifier.height(16.dp))

        // Device Identity Card
        Card(
            shape = BriskShapes.large,
            colors = CardDefaults.cardColors(containerColor = BriskColors.SurfaceSolidLight),
            modifier = Modifier.fillMaxWidth()
        ) {
            Column(modifier = Modifier.padding(16.dp)) {
                Text(
                    text = "DEVICE IDENTITY",
                    fontSize = 11.sp,
                    fontWeight = FontWeight.Bold,
                    color = BriskColors.TextTertiaryLight
                )
                Spacer(modifier = Modifier.height(6.dp))
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Text(
                        text = "Organization ID:",
                        fontSize = 12.sp,
                        color = BriskColors.TextSecondaryLight
                    )
                    Text(
                        text = secureStorage.organizationId ?: "Unknown",
                        fontSize = 12.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = BriskColors.TextPrimaryLight
                    )
                }
                Spacer(modifier = Modifier.height(4.dp))
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Text(
                        text = "Device Token ID:",
                        fontSize = 12.sp,
                        color = BriskColors.TextSecondaryLight
                    )
                    Text(
                        text = secureStorage.deviceId?.take(16) ?: "Unassigned",
                        fontSize = 12.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = BriskColors.TextPrimaryLight
                    )
                }
            }
        }

        Spacer(modifier = Modifier.height(16.dp))

        // Product Status Badges
        Text(
            text = "Product Status",
            fontSize = 14.sp,
            fontWeight = FontWeight.Bold,
            color = BriskColors.TextPrimaryLight,
            modifier = Modifier.padding(vertical = 4.dp)
        )

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            // Product A Card
            Card(
                shape = BriskShapes.medium,
                colors = CardDefaults.cardColors(containerColor = Color.White),
                modifier = Modifier
                    .weight(1f),
                onClick = onNavigateToPayment
            ) {
                Column(modifier = Modifier.padding(12.dp)) {
                    Text(
                        text = "Product A",
                        fontSize = 11.sp,
                        fontWeight = FontWeight.Bold,
                        color = BriskColors.AccentPrimary
                    )
                    Text(
                        text = "Payment Intel",
                        fontSize = 13.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = BriskColors.TextPrimaryLight
                    )
                    Spacer(modifier = Modifier.height(6.dp))
                    Text(
                        text = if (secureStorage.isPaymentIntelligenceEnabled) "Active Relay" else "Disabled",
                        fontSize = 11.sp,
                        color = if (secureStorage.isPaymentIntelligenceEnabled) BriskColors.StatusVerified else BriskColors.TextTertiaryLight,
                        fontWeight = FontWeight.Bold
                    )
                }
            }

            // Product B Card
            Card(
                shape = BriskShapes.medium,
                colors = CardDefaults.cardColors(containerColor = Color.White),
                modifier = Modifier
                    .weight(1f),
                onClick = onNavigateToMessaging
            ) {
                Column(modifier = Modifier.padding(12.dp)) {
                    Text(
                        text = "Product B",
                        fontSize = 11.sp,
                        fontWeight = FontWeight.Bold,
                        color = BriskColors.AccentPrimary
                    )
                    Text(
                        text = "SMSGate Gateway",
                        fontSize = 13.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = BriskColors.TextPrimaryLight
                    )
                    Spacer(modifier = Modifier.height(6.dp))
                    Text(
                        text = if (secureStorage.isBulkMessagingEnabled) "Cellular Active" else "Disabled",
                        fontSize = 11.sp,
                        color = if (secureStorage.isBulkMessagingEnabled) BriskColors.StatusVerified else BriskColors.TextTertiaryLight,
                        fontWeight = FontWeight.Bold
                    )
                }
            }
        }

        Spacer(modifier = Modifier.height(20.dp))

        // Today's Operational Metrics
        Text(
            text = "Today's Metrics",
            fontSize = 14.sp,
            fontWeight = FontWeight.Bold,
            color = BriskColors.TextPrimaryLight,
            modifier = Modifier.padding(vertical = 4.dp)
        )

        Card(
            shape = BriskShapes.large,
            colors = CardDefaults.cardColors(containerColor = Color.White),
            modifier = Modifier.fillMaxWidth()
        ) {
            Column(modifier = Modifier.padding(16.dp)) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Column {
                        Text(
                            text = "NOTIFICATIONS CAPTURED",
                            fontSize = 10.sp,
                            fontWeight = FontWeight.Bold,
                            color = BriskColors.TextTertiaryLight
                        )
                        Text(
                            text = "$collectedToday",
                            fontSize = 22.sp,
                            fontWeight = FontWeight.Bold,
                            color = BriskColors.TextPrimaryLight
                        )
                    }
                    Column(horizontalAlignment = Alignment.End) {
                        Text(
                            text = "NOTIFICATIONS FORWARDED",
                            fontSize = 10.sp,
                            fontWeight = FontWeight.Bold,
                            color = BriskColors.TextTertiaryLight
                        )
                        Text(
                            text = "$uploadedToday",
                            fontSize = 22.sp,
                            fontWeight = FontWeight.Bold,
                            color = BriskColors.StatusVerified
                        )
                    }
                }

                Divider(
                    modifier = Modifier.padding(vertical = 12.dp),
                    color = BriskColors.BorderHairlineLight
                )

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Column {
                        Text(
                            text = "CELLULAR SMS SENT",
                            fontSize = 10.sp,
                            fontWeight = FontWeight.Bold,
                            color = BriskColors.TextTertiaryLight
                        )
                        Text(
                            text = "$smsDispatchedToday",
                            fontSize = 22.sp,
                            fontWeight = FontWeight.Bold,
                            color = BriskColors.TextPrimaryLight
                        )
                    }
                    Column(horizontalAlignment = Alignment.End) {
                        Text(
                            text = "DELIVERED TO HANDSET",
                            fontSize = 10.sp,
                            fontWeight = FontWeight.Bold,
                            color = BriskColors.TextTertiaryLight
                        )
                        Text(
                            text = "$smsDeliveredToday",
                            fontSize = 22.sp,
                            fontWeight = FontWeight.Bold,
                            color = BriskColors.StatusVerified
                        )
                    }
                }
            }
        }

        Spacer(modifier = Modifier.height(24.dp))

        // Quick Sync Action Button
        Button(
            onClick = {
                isSyncing = true
                coroutineScope.launch {
                    val uploadWork = OneTimeWorkRequestBuilder<EvidenceUploadWorker>().build()
                    val telemetryWork = OneTimeWorkRequestBuilder<TelemetryWorker>().build()
                    WorkManager.getInstance(context).enqueue(uploadWork)
                    WorkManager.getInstance(context).enqueue(telemetryWork)

                    withContext(Dispatchers.IO) {
                        collectedToday = db.evidenceDao().countCollectedSince(startOfDay)
                        uploadedToday = db.evidenceDao().countUploadedSince(startOfDay)
                        smsDispatchedToday = db.smsDispatchDao().countSentSince(startOfDay)
                        smsDeliveredToday = db.smsDispatchDao().countDeliveredSince(startOfDay)
                    }
                    isSyncing = false
                }
            },
            enabled = !isSyncing,
            shape = BriskShapes.extraLarge,
            colors = ButtonDefaults.buttonColors(
                containerColor = BriskColors.ContrastPill,
                contentColor = Color.White
            ),
            modifier = Modifier
                .fillMaxWidth()
                .height(48.dp)
        ) {
            if (isSyncing) {
                CircularProgressIndicator(color = Color.White, modifier = Modifier.size(20.dp))
            } else {
                Text(text = "Sync & Force Upload Now", fontWeight = FontWeight.SemiBold)
            }
        }
    }
}
