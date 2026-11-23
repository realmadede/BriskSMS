package tz.co.brisksms.ui.payment

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import tz.co.brisksms.BuildConfig
import tz.co.brisksms.core.storage.KeystoreSecureStorage
import tz.co.brisksms.data.local.BriskDatabase
import tz.co.brisksms.data.local.OfflineEvidenceEntity
import tz.co.brisksms.payment.crypto.EvidenceEncryptor
import tz.co.brisksms.payment.provider.PaymentProviderRegistry
import tz.co.brisksms.R
import tz.co.brisksms.ui.components.*
import tz.co.brisksms.ui.theme.BriskColors
import tz.co.brisksms.ui.theme.BriskMonoStyle
import tz.co.brisksms.ui.theme.BriskShapes
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private val GroupRadius = 22.dp

/** A captured text with its decrypted, masked body, prepared off the main thread. */
private data class EvidenceRow(val item: OfflineEvidenceEntity, val text: String)

private enum class EvidenceFilter(val label: String) { All("All"), Queued("Queued"), Forwarded("Forwarded") }

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun PaymentIntelligenceScreen() {
    val context = LocalContext.current
    val coroutineScope = rememberCoroutineScope()
    val db = remember { BriskDatabase.getInstance(context) }
    val secureStorage = remember { KeystoreSecureStorage(context) }
    val encryptor = remember { EvidenceEncryptor(secureStorage) }

    var rows by remember { mutableStateOf<List<EvidenceRow>>(emptyList()) }
    var pendingCount by remember { mutableStateOf(0) }
    var captureActive by remember { mutableStateOf(false) }
    var showClearDialog by remember { mutableStateOf(false) }
    var filter by remember { mutableStateOf(EvidenceFilter.All) }
    var selected by remember { mutableStateOf<EvidenceRow?>(null) }

    fun refreshData() {
        coroutineScope.launch {
            withContext(Dispatchers.IO) {
                val recent = db.evidenceDao().getRecentEvidence()
                // Decrypt once here, not on every recomposition of a list row
                rows = recent.map { EvidenceRow(it, maskSensitiveDigits(encryptor.decryptPayload(it.rawPayload))) }
                pendingCount = db.evidenceDao().countPending()
                val notificationAccess = NotificationManagerCompat.getEnabledListenerPackages(context).contains(context.packageName)
                val textAccess = BuildConfig.SMS_PAYMENT_CAPTURE &&
                    ContextCompat.checkSelfPermission(context, Manifest.permission.RECEIVE_SMS) == PackageManager.PERMISSION_GRANTED
                captureActive = notificationAccess || textAccess
            }
        }
    }

    // Reload when the user comes back from Android settings after granting access
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_RESUME) refreshData() }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    // Names come from the registry, so this list cannot drift from what the app actually accepts
    val supportedSenders = remember { PaymentProviderRegistry.REGISTERED_APPS.map { it.providerName }.distinct() }
    val timeFormatter = remember { SimpleDateFormat("HH:mm", Locale.getDefault()) }

    val filtered = remember(rows, filter) {
        rows.filter {
            when (filter) {
                EvidenceFilter.All -> true
                EvidenceFilter.Queued -> !it.item.isUploaded
                EvidenceFilter.Forwarded -> it.item.isUploaded
            }
        }
    }
    val grouped = remember(filtered) { filtered.groupBy { dayLabel(it.item.createdAt) } }

    val listState = rememberLazyListState()
    val collapse = rememberTitleCollapse(listState)

    Box(modifier = Modifier.fillMaxSize().background(BriskColors.canvasBase())) {
        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(
                start = ScreenPadding,
                end = ScreenPadding,
                bottom = 16.dp + LocalBottomBarInset.current
            )
        ) {
            item(key = "title") {
                LargeTitle(
                    title = "Payments",
                    subtitle = "Payment texts captured from mobile money and bank senders",
                    modifier = Modifier
                        .padding(top = 24.dp, bottom = 16.dp)
                        .fadeWithCollapse(collapse),
                    trailing = {
                        StatusTag(
                            kind = if (captureActive) StatusKind.Positive else StatusKind.Review,
                            text = if (captureActive) "Listening" else "Needs access"
                        )
                    }
                )
            }

            if (!captureActive) {
                item(key = "access") {
                    Column(modifier = Modifier.padding(bottom = 16.dp)) {
                        AccessCard(context)
                    }
                }
            }

            item(key = "queue") {
                BriskCard(modifier = Modifier.fillMaxWidth()) {
                    Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.Bottom) {
                        Figure("Waiting to upload", "%,d".format(pendingCount), Modifier.weight(1f))
                        Column(horizontalAlignment = Alignment.End) {
                            Text("Local encryption", style = MaterialTheme.typography.bodySmall, color = BriskColors.textSecondary())
                            Spacer(modifier = Modifier.height(4.dp))
                            Text("AES-256-GCM", style = BriskMonoStyle, color = BriskColors.textPrimary())
                        }
                    }
                }
            }

            item(key = "senders") {
                Column(modifier = Modifier.padding(top = 24.dp)) {
                    SectionLabel("Supported senders")
                    Row(
                        modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                        horizontalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        supportedSenders.forEach { name ->
                            Surface(
                                shape = BriskShapes.extraLarge,
                                color = BriskColors.cardContainer(),
                                border = BorderStroke(Dp.Hairline, BriskColors.borderHairline())
                            ) {
                                Text(
                                    text = name,
                                    style = MaterialTheme.typography.labelMedium,
                                    color = BriskColors.textPrimary(),
                                    maxLines = 1,
                                    modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp)
                                )
                            }
                        }
                    }
                }
            }

            item(key = "filter") {
                Column(modifier = Modifier.padding(top = 24.dp)) {
                    GlassSegmented(
                        options = EvidenceFilter.values().map { it.label },
                        selectedIndex = filter.ordinal,
                        onSelect = { filter = EvidenceFilter.values()[it] }
                    )
                }
            }

            if (filtered.isEmpty()) {
                item(key = "empty") {
                    Column(
                        modifier = Modifier.fillMaxWidth().padding(vertical = 48.dp),
                        horizontalAlignment = Alignment.CenterHorizontally
                    ) {
                        Icon(
                            painter = painterResource(R.drawable.ic_receipt),
                            contentDescription = null,
                            tint = BriskColors.textTertiary(),
                            modifier = Modifier.size(24.dp)
                        )
                        Spacer(modifier = Modifier.height(12.dp))
                        Text(
                            text = when {
                                rows.isEmpty() -> "No payment texts yet"
                                filter == EvidenceFilter.Queued -> "Nothing is waiting to upload"
                                else -> "Nothing forwarded yet"
                            },
                            style = MaterialTheme.typography.titleSmall,
                            color = BriskColors.textPrimary()
                        )
                        Spacer(modifier = Modifier.height(4.dp))
                        Text(
                            text = "Payment texts from supported senders appear here as they arrive",
                            style = MaterialTheme.typography.bodySmall,
                            color = BriskColors.textSecondary(),
                            textAlign = TextAlign.Center
                        )
                    }
                }
            } else {
                grouped.forEach { (day, dayRows) ->
                    item(key = "day_$day") { GroupedSectionHeader(day) }
                    itemsIndexed(dayRows, key = { _, row -> row.item.id }) { index, row ->
                        EvidenceListRow(
                            row = row,
                            time = timeFormatter.format(Date(row.item.createdAt)),
                            shape = groupedShape(index, dayRows.size, GroupRadius),
                            showDivider = index < dayRows.size - 1,
                            onClick = { selected = row },
                            modifier = Modifier.animateItemPlacement()
                        )
                    }
                }
                if (rows.any { it.item.isUploaded }) {
                    item(key = "clear") {
                        TextButton(
                            onClick = { showClearDialog = true },
                            colors = ButtonDefaults.textButtonColors(contentColor = BriskColors.accentInk()),
                            modifier = Modifier.padding(top = 8.dp)
                        ) {
                            Text("Clear forwarded texts", style = MaterialTheme.typography.labelMedium)
                        }
                    }
                }
            }
        }

        // Compact bar that takes over from the large title once it has scrolled away
        GlassTopBar(title = "Payments", progress = collapse.value, modifier = Modifier.align(Alignment.TopCenter))
    }

    selected?.let { row ->
        EvidenceSheet(row = row, onDismiss = { selected = null })
    }

    if (showClearDialog) {
        AlertDialog(
            onDismissRequest = { showClearDialog = false },
            containerColor = BriskColors.cardContainer(),
            shape = BriskShapes.large,
            title = { Text("Clear forwarded texts?") },
            text = { Text("Payment texts already forwarded are removed from this phone's local storage. Texts waiting to upload stay.") },
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
                    Text("Clear", color = BriskColors.negativeInk())
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

@Composable
private fun AccessCard(context: android.content.Context) {
    val textCapture = BuildConfig.SMS_PAYMENT_CAPTURE
    BriskCard(modifier = Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.Top) {
            Icon(
                painter = painterResource(R.drawable.ic_triangle_alert),
                contentDescription = null,
                tint = BriskColors.StatusReview,
                modifier = Modifier.size(20.dp)
            )
            Spacer(modifier = Modifier.width(12.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = "Payment capture is off",
                    style = MaterialTheme.typography.titleSmall,
                    color = BriskColors.textPrimary()
                )
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = if (textCapture) {
                        "Allow BriskSMS to receive payment texts in this app's permissions, or turn on notification access."
                    } else {
                        "Allow notification access so this phone can read the payment text your Messages app shows."
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = BriskColors.textSecondary()
                )
            }
        }
        Spacer(modifier = Modifier.height(16.dp))
        PrimaryPillButton(
            text = if (textCapture) "Open app permissions" else "Open notification access",
            icon = if (textCapture) R.drawable.ic_settings else R.drawable.ic_bell,
            onClick = {
                val intent = if (textCapture) {
                    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))
                } else {
                    Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
                }
                context.startActivity(intent)
            }
        )
    }
}

@Composable
private fun EvidenceListRow(
    row: EvidenceRow,
    time: String,
    shape: RoundedCornerShape,
    showDivider: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    Surface(shape = shape, color = BriskColors.cardContainer(), modifier = modifier.fillMaxWidth()) {
        Column(modifier = Modifier.clickable(onClick = onClick)) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
                verticalAlignment = Alignment.Top
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = row.item.senderAddress,
                        style = MaterialTheme.typography.titleSmall,
                        color = BriskColors.textPrimary(),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                    Spacer(modifier = Modifier.height(2.dp))
                    Text(
                        text = row.text,
                        style = MaterialTheme.typography.bodySmall,
                        color = BriskColors.textSecondary(),
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis
                    )
                }
                Spacer(modifier = Modifier.width(12.dp))
                Column(horizontalAlignment = Alignment.End) {
                    Text(time, style = MaterialTheme.typography.labelSmall, color = BriskColors.textSecondary())
                    Spacer(modifier = Modifier.height(6.dp))
                    StatusTag(
                        kind = if (row.item.isUploaded) StatusKind.Positive else StatusKind.Review,
                        text = if (row.item.isUploaded) "Forwarded" else "Queued"
                    )
                }
            }
            if (showDivider) HairlineDivider(modifier = Modifier.padding(start = 16.dp))
        }
    }
}

@Composable
private fun EvidenceSheet(row: EvidenceRow, onDismiss: () -> Unit) {
    val item = row.item
    val stamp = remember { SimpleDateFormat("d MMM yyyy, HH:mm:ss", Locale.getDefault()) }
    DetailSheet(
        title = item.senderAddress,
        status = {
            StatusTag(
                kind = if (item.isUploaded) StatusKind.Positive else StatusKind.Review,
                text = if (item.isUploaded) "Forwarded" else "Queued"
            )
        },
        body = row.text,
        details = listOf(
            "Received" to stamp.format(Date(item.createdAt)),
            "Channel" to if (item.packageName == "sms") "Text message" else "Messages notification",
            "SIM" to "SIM ${item.simSlot}",
            "Upload" to (item.uploadedAt?.let { "Forwarded ${stamp.format(Date(it))}" } ?: "Waiting to upload")
        ),
        onDismiss = onDismiss
    )
}

/**
 * Masks sensitive account numbers in evidence text for operator safety
 */
private fun maskSensitiveDigits(text: String): String {
    // Mask phone numbers or account numbers (7+ digits)
    return text.replace(Regex("(\\d{3})\\d{3,5}(\\d{3})"), "$1****$2")
}
