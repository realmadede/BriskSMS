package tz.co.brisksms.ui.payment

import android.content.Intent
import android.provider.Settings
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
import androidx.core.app.NotificationManagerCompat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import tz.co.brisksms.core.storage.KeystoreSecureStorage
import tz.co.brisksms.data.local.BriskDatabase
import tz.co.brisksms.data.local.OfflineEvidenceEntity
import tz.co.brisksms.payment.crypto.EvidenceEncryptor
import tz.co.brisksms.ui.theme.BriskColors
import tz.co.brisksms.ui.theme.BriskShapes
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@Composable
fun PaymentIntelligenceScreen() {
    val context = LocalContext.current
    val coroutineScope = rememberCoroutineScope()
    val db = remember { BriskDatabase.getInstance(context) }
    val secureStorage = remember { KeystoreSecureStorage(context) }
    val encryptor = remember { EvidenceEncryptor(secureStorage) }

    var recentEvidence by remember { mutableStateOf<List<OfflineEvidenceEntity>>(emptyList()) }
    var pendingCount by remember { mutableStateOf(0) }
    var isNotificationListenerEnabled by remember { mutableStateOf(false) }
    var showClearDialog by remember { mutableStateOf(false) }

    fun refreshData() {
        coroutineScope.launch {
            withContext(Dispatchers.IO) {
                recentEvidence = db.evidenceDao().getRecentEvidence()
                pendingCount = db.evidenceDao().countPending()
                val enabledListeners = NotificationManagerCompat.getEnabledListenerPackages(context)
                isNotificationListenerEnabled = enabledListeners.contains(context.packageName)
            }
        }
    }

    LaunchedEffect(Unit) {
        refreshData()
    }

    val supportedProviders = remember {
        listOf(
            "Vodacom M-Pesa" to "com.mpesa.tz",
            "Mixx by Yas" to "com.yas.mixx",
            "Airtel Money" to "com.airtel.africa.money",
            "CRDB SimBanking" to "com.crdb.simbanking",
            "NMB Mkononi" to "com.nmb.mobile"
        )
    }

    val timeFormatter = remember { SimpleDateFormat("HH:mm:ss dd/MM", Locale.getDefault()) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(BriskColors.CanvasBaseLight)
            .padding(20.dp)
    ) {
        // Top Header
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = 4.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column {
                Text(
                    text = "Payment Intelligence",
                    fontSize = 20.sp,
                    fontWeight = FontWeight.Bold,
                    color = BriskColors.TextPrimaryLight
                )
                Text(
                    text = "Product A: Financial Notification Ingestion",
                    fontSize = 12.sp,
                    color = BriskColors.TextSecondaryLight
                )
            }

            Surface(
                shape = BriskShapes.extraLarge,
                color = if (isNotificationListenerEnabled)
                    BriskColors.StatusVerified.copy(alpha = 0.15f)
                else
                    BriskColors.StatusReview.copy(alpha = 0.15f)
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
                                if (isNotificationListenerEnabled) BriskColors.StatusVerified else BriskColors.StatusReview,
                                CircleShape
                            )
                    )
                    Text(
                        text = if (isNotificationListenerEnabled) "LISTENING" else "ACTION REQ",
                        fontSize = 11.sp,
                        fontWeight = FontWeight.Bold,
                        color = if (isNotificationListenerEnabled) BriskColors.StatusVerified else BriskColors.StatusReview
                    )
                }
            }
        }

        Spacer(modifier = Modifier.height(12.dp))

        // Notification Access Banner if not enabled
        if (!isNotificationListenerEnabled) {
            Card(
                shape = BriskShapes.medium,
                colors = CardDefaults.cardColors(containerColor = BriskColors.StatusReview.copy(alpha = 0.1f)),
                modifier = Modifier.fillMaxWidth()
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(12.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        text = "Notification access required to observe payments",
                        fontSize = 12.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = BriskColors.StatusReview,
                        modifier = Modifier.weight(1f)
                    )
                    Button(
                        onClick = {
                            context.startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
                        },
                        shape = BriskShapes.extraLarge,
                        colors = ButtonDefaults.buttonColors(
                            containerColor = BriskColors.StatusReview,
                            contentColor = Color.White
                        ),
                        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 6.dp)
                    ) {
                        Text(text = "Grant", fontSize = 11.sp, fontWeight = FontWeight.Bold)
                    }
                }
            }
            Spacer(modifier = Modifier.height(12.dp))
        }

        // Summary Metric & Queue Depth
        Card(
            shape = BriskShapes.large,
            colors = CardDefaults.cardColors(containerColor = BriskColors.SurfaceSolidLight),
            modifier = Modifier.fillMaxWidth()
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(16.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column {
                    Text(
                        text = "OFFLINE QUEUE DEPTH",
                        fontSize = 10.sp,
                        fontWeight = FontWeight.Bold,
                        color = BriskColors.TextTertiaryLight
                    )
                    Text(
                        text = "$pendingCount",
                        fontSize = 24.sp,
                        fontWeight = FontWeight.Bold,
                        color = if (pendingCount > 0) BriskColors.StatusReview else BriskColors.StatusVerified
                    )
                }
                Column(horizontalAlignment = Alignment.End) {
                    Text(
                        text = "LOCAL ENCRYPTION",
                        fontSize = 10.sp,
                        fontWeight = FontWeight.Bold,
                        color = BriskColors.TextTertiaryLight
                    )
                    Text(
                        text = "AES-256-GCM",
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Bold,
                        color = BriskColors.StatusVerified
                    )
                }
            }
        }

        Spacer(modifier = Modifier.height(16.dp))

        // Supported Monitored Providers Chips
        Text(
            text = "Monitored Mobile Money & Bank Packages",
            fontSize = 13.sp,
            fontWeight = FontWeight.Bold,
            color = BriskColors.TextPrimaryLight,
            modifier = Modifier.padding(bottom = 6.dp)
        )

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            supportedProviders.take(3).forEach { (name, _) ->
                Surface(
                    shape = BriskShapes.extraLarge,
                    color = Color.White,
                    modifier = Modifier.weight(1f)
                ) {
                    Text(
                        text = name,
                        fontSize = 10.sp,
                        fontWeight = FontWeight.Medium,
                        color = BriskColors.TextSecondaryLight,
                        modifier = Modifier.padding(vertical = 4.dp, horizontal = 6.dp),
                        maxLines = 1
                    )
                }
            }
        }

        Spacer(modifier = Modifier.height(16.dp))

        // Evidence Feed Header
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(bottom = 8.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = "Captured Financial Notifications",
                fontSize = 14.sp,
                fontWeight = FontWeight.Bold,
                color = BriskColors.TextPrimaryLight
            )

            TextButton(
                onClick = { showClearDialog = true },
                enabled = recentEvidence.any { it.isUploaded }
            ) {
                Text(
                    text = "Clear Processed",
                    fontSize = 11.sp,
                    color = BriskColors.TextSecondaryLight
                )
            }
        }

        if (recentEvidence.isEmpty()) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f),
                contentAlignment = Alignment.Center
            ) {
                Text(
                    text = "No captured notifications. Payment evidence will appear here.",
                    fontSize = 13.sp,
                    color = BriskColors.TextSecondaryLight
                )
            }
        } else {
            LazyColumn(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                items(recentEvidence) { item ->
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
                                    text = item.senderAddress,
                                    fontSize = 13.sp,
                                    fontWeight = FontWeight.Bold,
                                    color = BriskColors.TextPrimaryLight
                                )

                                Surface(
                                    shape = BriskShapes.extraLarge,
                                    color = if (item.isUploaded)
                                        BriskColors.StatusVerified.copy(alpha = 0.15f)
                                    else
                                        BriskColors.StatusReview.copy(alpha = 0.15f)
                                ) {
                                    Text(
                                        text = if (item.isUploaded) "FORWARDED" else "QUEUED",
                                        fontSize = 10.sp,
                                        fontWeight = FontWeight.Bold,
                                        color = if (item.isUploaded) BriskColors.StatusVerified else BriskColors.StatusReview,
                                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp)
                                    )
                                }
                            }

                            Spacer(modifier = Modifier.height(4.dp))

                            // Decrypt or preview with sensitive mask
                            val decrypted = encryptor.decrypt(item.rawPayload)
                            val displayText = maskSensitiveDigits(decrypted)

                            Text(
                                text = displayText,
                                fontSize = 12.sp,
                                color = BriskColors.TextSecondaryLight,
                                maxLines = 2
                            )

                            Spacer(modifier = Modifier.height(6.dp))

                            Text(
                                text = timeFormatter.format(Date(item.createdAt)),
                                fontSize = 10.sp,
                                color = BriskColors.TextTertiaryLight
                            )
                        }
                    }
                }
            }
        }
    }

    if (showClearDialog) {
        AlertDialog(
            onDismissRequest = { showClearDialog = false },
            title = { Text("Clear Processed Evidence") },
            text = { Text("Are you sure you want to remove successfully forwarded evidence from local SQLite storage?") },
            confirmButton = {
                TextButton(
                    onClick = {
                        showClearDialog = false
                        coroutineScope.launch {
                            withContext(Dispatchers.IO) {
                                db.evidenceDao().clearUploadedEvidence()
                            }
                            refreshData()
                        }
                    }
                ) {
                    Text("Clear", color = BriskColors.StatusRejected)
                }
            },
            dismissButton = {
                TextButton(onClick = { showClearDialog = false }) {
                    Text("Cancel")
                }
            }
        )
    }
}

/**
 * Masks sensitive account numbers in evidence text for operator safety
 */
private fun maskSensitiveDigits(text: String): String {
    // Mask phone numbers or account numbers (7+ digits)
    return text.replace(Regex("(\\d{3})\\d{3,5}(\\d{3})"), "$1****$2")
}
