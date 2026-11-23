package tz.co.brisksms.ui.messaging

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import tz.co.brisksms.core.storage.KeystoreSecureStorage
import tz.co.brisksms.data.local.BriskDatabase
import tz.co.brisksms.messaging.data.SmsDispatchEntity
import tz.co.brisksms.messaging.dispatcher.SmsDispatcher
import tz.co.brisksms.messaging.service.SmsGateRelayService
import tz.co.brisksms.messaging.sim.SimManager
import tz.co.brisksms.messaging.sim.SimSlotInfo
import tz.co.brisksms.R
import tz.co.brisksms.ui.components.*
import tz.co.brisksms.ui.theme.BriskColors
import tz.co.brisksms.ui.theme.BriskMonoStyle
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

private val GroupRadius = 22.dp

private enum class DispatchFilter(val label: String) {
    All("All"), Pending("Pending"), Delivered("Delivered"), Failed("Failed")
}

private fun statusTag(status: String): Pair<StatusKind, String> = when (status) {
    "DELIVERED" -> StatusKind.Positive to "Delivered"
    "SUBMITTED" -> StatusKind.Accent to "Submitted"
    "FAILED" -> StatusKind.Negative to "Failed"
    else -> StatusKind.Review to status.lowercase().replaceFirstChar { it.uppercase() }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun BulkMessagingScreen() {
    val context = LocalContext.current
    val db = remember { BriskDatabase.getInstance(context) }
    val secureStorage = remember { KeystoreSecureStorage(context) }
    val simManager = remember { SimManager(context) }

    var recentDispatches by remember { mutableStateOf<List<SmsDispatchEntity>>(emptyList()) }
    var pendingCount by remember { mutableStateOf(0) }
    var inFlightCount by remember { mutableStateOf(0) }
    var simSlots by remember { mutableStateOf<List<SimSlotInfo>>(emptyList()) }
    var sim1SentToday by remember { mutableStateOf(0) }
    var sim2SentToday by remember { mutableStateOf(0) }
    var filter by remember { mutableStateOf(DispatchFilter.All) }
    var selected by remember { mutableStateOf<SmsDispatchEntity?>(null) }

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
    val timeFormatter = remember { SimpleDateFormat("HH:mm", Locale.getDefault()) }

    val sim1 = simSlots.find { it.simNumber == 1 }
    val sim2 = simSlots.find { it.simNumber == 2 }

    val filtered = remember(recentDispatches, filter) {
        recentDispatches.filter {
            when (filter) {
                DispatchFilter.All -> true
                DispatchFilter.Pending -> it.status != "DELIVERED" && it.status != "FAILED"
                DispatchFilter.Delivered -> it.status == "DELIVERED"
                DispatchFilter.Failed -> it.status == "FAILED"
            }
        }
    }
    val grouped = remember(filtered) { filtered.groupBy { dayLabel(it.createdAt) } }

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
                    title = "Messaging",
                    subtitle = "Bulk SMS sent through this phone's SIM cards",
                    modifier = Modifier.padding(top = 24.dp, bottom = 16.dp).fadeWithCollapse(collapse),
                    trailing = {
                        StatusTag(
                            kind = if (secureStorage.isBulkMessagingEnabled) StatusKind.Positive else StatusKind.Negative,
                            text = if (secureStorage.isBulkMessagingEnabled) "Gateway on" else "Offline"
                        )
                    }
                )
            }

            item(key = "gateway") {
                BriskCard(
                    modifier = Modifier.fillMaxWidth(),
                    contentPadding = PaddingValues(horizontal = 16.dp, vertical = 4.dp)
                ) {
                    KeyValueRow("Gateway mode", if (isManagedGateway) "Managed" else "External relay")
                    if (!isManagedGateway) {
                        HairlineDivider()
                        KeyValueRow("Endpoint", secureStorage.smsGateBaseUrl, mono = true)
                    }
                }
            }

            item(key = "sims") {
                Column(modifier = Modifier.padding(top = 24.dp)) {
                    SectionLabel("SIM cards")
                    Row(
                        modifier = Modifier.fillMaxWidth().height(IntrinsicSize.Min),
                        horizontalArrangement = Arrangement.spacedBy(12.dp)
                    ) {
                        SimCard("SIM 1", sim1?.carrierName, sim1SentToday, Modifier.weight(1f).fillMaxHeight())
                        SimCard("SIM 2", sim2?.carrierName, sim2SentToday, Modifier.weight(1f).fillMaxHeight())
                    }
                }
            }

            item(key = "queue") {
                BriskCard(modifier = Modifier.fillMaxWidth().padding(top = 12.dp)) {
                    Row(modifier = Modifier.fillMaxWidth()) {
                        Figure("Queued", "%,d".format(pendingCount), Modifier.weight(1f))
                        Figure("In flight", "%,d".format(inFlightCount), Modifier.weight(1f))
                        Figure("Message gap", "%.1fs".format(SmsGateRelayService.DEFAULT_DISPATCH_PACING_MS / 1000.0), Modifier.weight(1f))
                    }
                }
            }

            item(key = "filter") {
                Column(modifier = Modifier.padding(top = 24.dp)) {
                    GlassSegmented(
                        options = DispatchFilter.values().map { it.label },
                        selectedIndex = filter.ordinal,
                        onSelect = { filter = DispatchFilter.values()[it] }
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
                            painter = painterResource(R.drawable.ic_message_square),
                            contentDescription = null,
                            tint = BriskColors.textTertiary(),
                            modifier = Modifier.size(24.dp)
                        )
                        Spacer(modifier = Modifier.height(12.dp))
                        Text(
                            text = if (recentDispatches.isEmpty()) "No messages sent yet" else "No ${filter.label.lowercase()} messages",
                            style = MaterialTheme.typography.titleSmall,
                            color = BriskColors.textPrimary()
                        )
                        Spacer(modifier = Modifier.height(4.dp))
                        Text(
                            text = "Messages sent through this phone appear here",
                            style = MaterialTheme.typography.bodySmall,
                            color = BriskColors.textSecondary(),
                            textAlign = TextAlign.Center
                        )
                    }
                }
            } else {
                grouped.forEach { (day, dayRows) ->
                    item(key = "day_$day") { GroupedSectionHeader(day) }
                    itemsIndexed(dayRows, key = { _, d -> d.id }) { index, dispatch ->
                        DispatchRow(
                            dispatch = dispatch,
                            time = timeFormatter.format(Date(dispatch.createdAt)),
                            shape = groupedShape(index, dayRows.size, GroupRadius),
                            showDivider = index < dayRows.size - 1,
                            onClick = { selected = dispatch },
                            modifier = Modifier.animateItemPlacement()
                        )
                    }
                }
            }
        }

        GlassTopBar(title = "Messaging", progress = collapse.value, modifier = Modifier.align(Alignment.TopCenter))
    }

    selected?.let { dispatch ->
        val stamp = remember { SimpleDateFormat("d MMM yyyy, HH:mm:ss", Locale.getDefault()) }
        val (kind, label) = statusTag(dispatch.status)
        DetailSheet(
            title = maskPhoneNumber(dispatch.recipientPhone),
            status = { StatusTag(kind = kind, text = label) },
            body = dispatch.messageText,
            details = buildList {
                add("Created" to stamp.format(Date(dispatch.createdAt)))
                add("SIM" to "SIM ${dispatch.simSlot}")
                add("Attempts" to "%,d".format(dispatch.attempts))
                dispatch.errorMessage?.let { add("Error" to it) }
            },
            onDismiss = { selected = null }
        )
    }
}

@Composable
private fun DispatchRow(
    dispatch: SmsDispatchEntity,
    time: String,
    shape: RoundedCornerShape,
    showDivider: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    val (kind, label) = statusTag(dispatch.status)
    Surface(shape = shape, color = BriskColors.cardContainer(), modifier = modifier.fillMaxWidth()) {
        Column(modifier = Modifier.clickable(onClick = onClick)) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
                verticalAlignment = Alignment.Top
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = maskPhoneNumber(dispatch.recipientPhone),
                        style = BriskMonoStyle,
                        color = BriskColors.textPrimary(),
                        maxLines = 1
                    )
                    Spacer(modifier = Modifier.height(2.dp))
                    Text(
                        text = dispatch.messageText,
                        style = MaterialTheme.typography.bodySmall,
                        color = BriskColors.textSecondary(),
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis
                    )
                }
                Spacer(modifier = Modifier.width(12.dp))
                Column(horizontalAlignment = Alignment.End) {
                    Text("SIM ${dispatch.simSlot} · $time", style = MaterialTheme.typography.labelSmall, color = BriskColors.textSecondary())
                    Spacer(modifier = Modifier.height(6.dp))
                    StatusTag(kind = kind, text = label)
                }
            }
            if (showDivider) HairlineDivider(modifier = Modifier.padding(start = 16.dp))
        }
    }
}

@Composable
private fun SimCard(slot: String, carrierName: String?, sentToday: Int, modifier: Modifier = Modifier) {
    BriskCard(modifier = modifier) {
        Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = slot,
                style = MaterialTheme.typography.labelMedium,
                color = BriskColors.textSecondary(),
                modifier = Modifier.weight(1f)
            )
            Icon(
                painter = painterResource(if (carrierName != null) R.drawable.ic_circle_check else R.drawable.ic_triangle_alert),
                contentDescription = null,
                tint = if (carrierName != null) BriskColors.StatusVerified else BriskColors.StatusReview,
                modifier = Modifier.size(16.dp)
            )
        }
        Spacer(modifier = Modifier.height(8.dp))
        Text(
            text = carrierName ?: "No SIM",
            style = MaterialTheme.typography.titleSmall,
            color = if (carrierName != null) BriskColors.textPrimary() else BriskColors.textSecondary(),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
        Spacer(modifier = Modifier.height(4.dp))
        Text(
            text = "%,d of %,d sent today".format(sentToday, SmsDispatcher.DEFAULT_SIM_DAILY_CAP),
            style = MaterialTheme.typography.bodySmall,
            color = BriskColors.textSecondary()
        )
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
