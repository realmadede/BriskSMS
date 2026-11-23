package tz.co.brisksms.ui.overview

import android.os.Build
import androidx.annotation.DrawableRes
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import tz.co.brisksms.core.storage.KeystoreSecureStorage
import tz.co.brisksms.data.local.BriskDatabase
import tz.co.brisksms.R
import tz.co.brisksms.ui.components.*
import tz.co.brisksms.ui.theme.BriskColors
import tz.co.brisksms.worker.EvidenceUploadWorker
import tz.co.brisksms.worker.TelemetryWorker
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

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

    val todayLabel = remember { SimpleDateFormat("d MMM yyyy", Locale.getDefault()).format(Date()) }
    val isActive = !secureStorage.isRevoked && secureStorage.isPaired

    CollapsingScreen(
        title = "Overview",
        subtitle = "Relay status and today's activity",
        trailing = {
            StatusTag(
                kind = if (isActive) StatusKind.Positive else StatusKind.Negative,
                text = if (secureStorage.isRevoked) "Revoked" else if (secureStorage.isPaired) "Active" else "Offline"
            )
        }
    ) {
        // Device identity
        SectionLabel("This device")
        BriskCard(
            modifier = Modifier.fillMaxWidth(),
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 4.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                BriskMark(size = 36.dp)
                Spacer(modifier = Modifier.width(12.dp))
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = "BriskSMS Companion",
                        style = MaterialTheme.typography.titleSmall,
                        color = BriskColors.textPrimary()
                    )
                    Text(
                        text = "${Build.MANUFACTURER} ${Build.MODEL}",
                        style = MaterialTheme.typography.bodySmall,
                        color = BriskColors.textSecondary(),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                }
            }
            HairlineDivider()
            val accountName = secureStorage.organizationName
            KeyValueRow("Account", accountName ?: secureStorage.organizationId ?: "Unknown", mono = accountName == null)
            HairlineDivider()
            KeyValueRow("Device ID", secureStorage.deviceId?.take(16) ?: "Unassigned", mono = true)
        }

        Spacer(modifier = Modifier.height(24.dp))

        // Product status
        SectionLabel("Products")
        BriskCard(modifier = Modifier.fillMaxWidth(), contentPadding = PaddingValues(0.dp)) {
            ProductRow(
                icon = R.drawable.ic_receipt,
                title = "Payment texts",
                isActive = secureStorage.isPaymentIntelligenceEnabled,
                onClick = onNavigateToPayment
            )
            HairlineDivider(modifier = Modifier.padding(start = 58.dp))
            ProductRow(
                icon = R.drawable.ic_message_square,
                title = "Bulk SMS",
                isActive = secureStorage.isBulkMessagingEnabled,
                onClick = onNavigateToMessaging
            )
        }

        Spacer(modifier = Modifier.height(24.dp))

        // Today's receipt
        BriskCard(modifier = Modifier.fillMaxWidth(), contentPadding = PaddingValues(0.dp)) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 8.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = "Today",
                    style = MaterialTheme.typography.titleMedium,
                    color = BriskColors.textPrimary(),
                    modifier = Modifier.weight(1f)
                )
                Text(text = todayLabel, style = MaterialTheme.typography.bodySmall, color = BriskColors.textSecondary())
            }
            PerforatedDivider()
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = 16.dp, end = 16.dp, top = 8.dp)
            ) {
                Figure("Texts captured", "%,d".format(collectedToday), Modifier.weight(1f))
                Figure("Texts forwarded", "%,d".format(uploadedToday), Modifier.weight(1f))
            }
            Spacer(modifier = Modifier.height(16.dp))
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = 16.dp, end = 16.dp, bottom = 20.dp)
            ) {
                Figure("SMS sent", "%,d".format(smsDispatchedToday), Modifier.weight(1f))
                Figure("SMS delivered", "%,d".format(smsDeliveredToday), Modifier.weight(1f))
            }
        }

        Spacer(modifier = Modifier.height(24.dp))

        PrimaryPillButton(
            text = "Sync now",
            icon = R.drawable.ic_refresh_cw,
            loading = isSyncing,
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
            }
        )
    }
}

@Composable
private fun ProductRow(@DrawableRes icon: Int, title: String, isActive: Boolean, onClick: () -> Unit) {
    ActionRow(
        icon = icon,
        text = title,
        onClick = onClick,
        status = {
            StatusTag(
                kind = if (isActive) StatusKind.Positive else StatusKind.Neutral,
                text = if (isActive) "Active" else "Off"
            )
        }
    )
}
