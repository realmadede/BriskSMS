package tz.co.brisksms.ui.messaging

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
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
import tz.co.brisksms.core.storage.KeystoreSecureStorage
import tz.co.brisksms.data.local.BriskDatabase
import tz.co.brisksms.messaging.data.SmsDispatchEntity
import tz.co.brisksms.messaging.sim.SimManager
import tz.co.brisksms.messaging.sim.SimSlotInfo
import tz.co.brisksms.ui.theme.BriskColors
import tz.co.brisksms.ui.theme.BriskShapes
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

@Composable
fun BulkMessagingScreen() {
    val context = LocalContext.current
    val coroutineScope = rememberCoroutineScope()
    val db = remember { BriskDatabase.getInstance(context) }
    val secureStorage = remember { KeystoreSecureStorage(context) }
    val simManager = remember { SimManager(context) }

    var recentDispatches by remember { mutableStateOf<List<SmsDispatchEntity>>(emptyList()) }
    var pendingCount by remember { mutableStateOf(0) }
    var inFlightCount by remember { mutableStateOf(0) }
    var simSlots by remember { mutableStateOf<List<SimSlotInfo>>(emptyList()) }
    var sim1SentToday by remember { mutableStateOf(0) }
    var sim2SentToday by remember { mutableStateOf(0) }

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
            simSlots = simManager.getActiveSimSlots()
            recentDispatches = db.smsDispatchDao().getRecentDispatches()
            pendingCount = db.smsDispatchDao().countPending()
            inFlightCount = db.smsDispatchDao().countInFlight()
            sim1SentToday = db.smsDispatchDao().countSlotSentSince(1, startOfDay)
            sim2SentToday = db.smsDispatchDao().countSlotSentSince(2, startOfDay)
        }
    }

    val isManagedGateway = secureStorage.gatewayMode == "MANAGED_GATEWAY"
    val timeFormatter = remember { SimpleDateFormat("HH:mm:ss dd/MM", Locale.getDefault()) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(BriskColors.CanvasBaseLight)
            .padding(20.dp)
    ) {
        // Screen Header
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = 4.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column {
                Text(
                    text = "Bulk Messaging",
                    fontSize = 20.sp,
                    fontWeight = FontWeight.Bold,
                    color = BriskColors.TextPrimaryLight
                )
                Text(
                    text = "Product B: Cellular SMSGate Gateway",
                    fontSize = 12.sp,
                    color = BriskColors.TextSecondaryLight
                )
            }

            Surface(
                shape = BriskShapes.extraLarge,
                color = if (secureStorage.isBulkMessagingEnabled)
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
                                if (secureStorage.isBulkMessagingEnabled) BriskColors.StatusVerified else BriskColors.StatusRejected,
                                CircleShape
                            )
                    )
                    Text(
                        text = if (secureStorage.isBulkMessagingEnabled) "GATEWAY ON" else "OFFLINE",
                        fontSize = 11.sp,
                        fontWeight = FontWeight.Bold,
                        color = if (secureStorage.isBulkMessagingEnabled) BriskColors.StatusVerified else BriskColors.StatusRejected
                    )
                }
            }
        }

        Spacer(modifier = Modifier.height(12.dp))

        // Gateway Mode & Endpoint Configuration Card
        Card(
            shape = BriskShapes.large,
            colors = CardDefaults.cardColors(containerColor = BriskColors.SurfaceSolidLight),
            modifier = Modifier.fillMaxWidth()
        ) {
            Column(modifier = Modifier.padding(14.dp)) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Text(
                        text = "GATEWAY OPERATING MODE",
                        fontSize = 10.sp,
                        fontWeight = FontWeight.Bold,
                        color = BriskColors.TextTertiaryLight
                    )
                    Surface(
                        shape = BriskShapes.extraLarge,
                        color = BriskColors.ContrastPill
                    ) {
                        Text(
                            text = if (isManagedGateway) "MANAGED VPS (Cloudflare)" else "EXTERNAL RELAY",
                            fontSize = 10.sp,
                            fontWeight = FontWeight.Bold,
                            color = Color.White,
                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp)
                        )
                    }
                }

                Spacer(modifier = Modifier.height(6.dp))

                Text(
                    text = "Endpoint: ${secureStorage.smsGateBaseUrl}",
                    fontSize = 11.sp,
                    color = BriskColors.TextSecondaryLight,
                    maxLines = 1
                )
            }
        }

        Spacer(modifier = Modifier.height(14.dp))

        // Active SIM Cards Row
        Text(
            text = "Active Cellular SIMs (Dual-SIM)",
            fontSize = 13.sp,
            fontWeight = FontWeight.Bold,
            color = BriskColors.TextPrimaryLight,
            modifier = Modifier.padding(bottom = 6.dp)
        )

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            val sim1 = simSlots.find { it.simNumber == 1 }
            val sim2 = simSlots.find { it.simNumber == 2 }

            // SIM 1 Card
            Card(
                shape = BriskShapes.medium,
                colors = CardDefaults.cardColors(containerColor = Color.White),
                modifier = Modifier.weight(1f)
            ) {
                Column(modifier = Modifier.padding(12.dp)) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Text(
                            text = "SIM 1",
                            fontSize = 11.sp,
                            fontWeight = FontWeight.Bold,
                            color = BriskColors.AccentPrimary
                        )
                        Box(
                            modifier = Modifier
                                .size(6.dp)
                                .background(
                                    if (sim1 != null) BriskColors.StatusVerified else BriskColors.StatusReview,
                                    CircleShape
                                )
                        )
                    }
                    Text(
                        text = sim1?.carrierName ?: "Not Inserted",
                        fontSize = 13.sp,
                        fontWeight = FontWeight.Bold,
                        color = BriskColors.TextPrimaryLight
                    )
                    Spacer(modifier = Modifier.height(4.dp))
                    Text(
                        text = "Sent today: $sim1SentToday",
                        fontSize = 11.sp,
                        color = BriskColors.TextSecondaryLight
                    )
                }
            }

            // SIM 2 Card
            Card(
                shape = BriskShapes.medium,
                colors = CardDefaults.cardColors(containerColor = Color.White),
                modifier = Modifier.weight(1f)
            ) {
                Column(modifier = Modifier.padding(12.dp)) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Text(
                            text = "SIM 2",
                            fontSize = 11.sp,
                            fontWeight = FontWeight.Bold,
                            color = BriskColors.AccentPrimary
                        )
                        Box(
                            modifier = Modifier
                                .size(6.dp)
                                .background(
                                    if (sim2 != null) BriskColors.StatusVerified else BriskColors.StatusReview,
                                    CircleShape
                                )
                        )
                    }
                    Text(
                        text = sim2?.carrierName ?: "Empty Slot",
                        fontSize = 13.sp,
                        fontWeight = FontWeight.Bold,
                        color = BriskColors.TextPrimaryLight
                    )
                    Spacer(modifier = Modifier.height(4.dp))
                    Text(
                        text = "Sent today: $sim2SentToday",
                        fontSize = 11.sp,
                        color = BriskColors.TextSecondaryLight
                    )
                }
            }
        }

        Spacer(modifier = Modifier.height(14.dp))

        // Queue Status Metrics
        Card(
            shape = BriskShapes.large,
            colors = CardDefaults.cardColors(containerColor = BriskColors.SurfaceSolidLight),
            modifier = Modifier.fillMaxWidth()
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(14.dp),
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Column {
                    Text(
                        text = "QUEUED",
                        fontSize = 10.sp,
                        fontWeight = FontWeight.Bold,
                        color = BriskColors.TextTertiaryLight
                    )
                    Text(
                        text = "$pendingCount",
                        fontSize = 20.sp,
                        fontWeight = FontWeight.Bold,
                        color = if (pendingCount > 0) BriskColors.StatusReview else BriskColors.TextPrimaryLight
                    )
                }
                Column {
                    Text(
                        text = "IN FLIGHT",
                        fontSize = 10.sp,
                        fontWeight = FontWeight.Bold,
                        color = BriskColors.TextTertiaryLight
                    )
                    Text(
                        text = "$inFlightCount",
                        fontSize = 20.sp,
                        fontWeight = FontWeight.Bold,
                        color = BriskColors.TextPrimaryLight
                    )
                }
                Column(horizontalAlignment = Alignment.End) {
                    Text(
                        text = "RADIO PACING",
                        fontSize = 10.sp,
                        fontWeight = FontWeight.Bold,
                        color = BriskColors.TextTertiaryLight
                    )
                    Text(
                        text = "1.5s / SIM",
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Bold,
                        color = BriskColors.StatusVerified
                    )
                }
            }
        }

        Spacer(modifier = Modifier.height(14.dp))

        // Recent Dispatches Feed
        Text(
            text = "Recent Cellular Dispatches",
            fontSize = 13.sp,
            fontWeight = FontWeight.Bold,
            color = BriskColors.TextPrimaryLight,
            modifier = Modifier.padding(bottom = 6.dp)
        )

        if (recentDispatches.isEmpty()) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f),
                contentAlignment = Alignment.Center
            ) {
                Text(
                    text = "No outbound cellular messages in dispatch log.",
                    fontSize = 13.sp,
                    color = BriskColors.TextSecondaryLight
                )
            }
        } else {
            LazyColumn(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                items(recentDispatches) { dispatch ->
                    Card(
                        shape = BriskShapes.medium,
                        colors = CardDefaults.cardColors(containerColor = Color.White),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Column(modifier = Modifier.padding(12.dp)) {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Text(
                                    text = maskPhoneNumber(dispatch.recipientPhone),
                                    fontSize = 13.sp,
                                    fontWeight = FontWeight.Bold,
                                    color = BriskColors.TextPrimaryLight
                                )

                                val statusColor = when (dispatch.status) {
                                    "DELIVERED" -> BriskColors.StatusVerified
                                    "SUBMITTED" -> BriskColors.AccentPrimary
                                    "FAILED" -> BriskColors.StatusRejected
                                    else -> BriskColors.StatusReview
                                }

                                Surface(
                                    shape = BriskShapes.extraLarge,
                                    color = statusColor.copy(alpha = 0.15f)
                                ) {
                                    Text(
                                        text = dispatch.status,
                                        fontSize = 10.sp,
                                        fontWeight = FontWeight.Bold,
                                        color = statusColor,
                                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp)
                                    )
                                }
                            }

                            Spacer(modifier = Modifier.height(4.dp))

                            Text(
                                text = dispatch.messageText,
                                fontSize = 12.sp,
                                color = BriskColors.TextSecondaryLight,
                                maxLines = 1
                            )

                            Spacer(modifier = Modifier.height(4.dp))

                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween
                            ) {
                                Text(
                                    text = "SIM ${dispatch.simSlot}",
                                    fontSize = 10.sp,
                                    fontWeight = FontWeight.SemiBold,
                                    color = BriskColors.TextSecondaryLight
                                )
                                Text(
                                    text = timeFormatter.format(Date(dispatch.createdAt)),
                                    fontSize = 10.sp,
                                    color = BriskColors.TextTertiaryLight
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

/**
 * Masks recipient phone number (e.g. +255 712 *** 789)
 */
private fun maskPhoneNumber(phone: String): String {
    return if (phone.length >= 8) {
        val prefix = phone.take(6)
        val suffix = phone.takeLast(3)
        "$prefix *** $suffix"
    } else {
        phone
    }
}
