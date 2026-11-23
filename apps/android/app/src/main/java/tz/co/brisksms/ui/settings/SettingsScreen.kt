package tz.co.brisksms.ui.settings

import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.work.WorkManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import tz.co.brisksms.core.network.BriskApiClient
import tz.co.brisksms.core.storage.KeystoreSecureStorage
import tz.co.brisksms.data.local.BriskDatabase
import tz.co.brisksms.messaging.service.SmsGateRelayService
import tz.co.brisksms.security.KeystoreManager
import tz.co.brisksms.worker.DailySummaryWorker
import tz.co.brisksms.R
import tz.co.brisksms.ui.components.*
import tz.co.brisksms.ui.theme.BriskColors
import tz.co.brisksms.ui.theme.BriskMonoStyle
import tz.co.brisksms.ui.theme.BriskShapes

@Composable
fun SettingsScreen(
    onUnpaired: () -> Unit
) {
    val context = LocalContext.current
    val coroutineScope = rememberCoroutineScope()
    val secureStorage = remember { KeystoreSecureStorage(context) }
    var showDisconnectDialog by remember { mutableStateOf(false) }
    var isUnpairing by remember { mutableStateOf(false) }
    var unpairError by remember { mutableStateOf(false) }
    var appLockEnabled by remember { mutableStateOf(secureStorage.isAppLockEnabled) }
    var showNeedsScreenLock by remember { mutableStateOf(false) }
    var dailySummaryEnabled by remember { mutableStateOf(secureStorage.isDailySummaryEnabled) }
    var showBackgroundGuide by remember { mutableStateOf(false) }

    val rowsPadding = PaddingValues(horizontal = 16.dp, vertical = 4.dp)

    CollapsingScreen(
        title = "Settings",
        subtitle = "This phone, its servers and Android permissions"
    ) {
        // Account: a name and a type, not an ID. A personal account is a one-person workspace on the server.
        SectionLabel("Account")
        BriskCard(modifier = Modifier.fillMaxWidth(), contentPadding = rowsPadding) {
            val accountName = secureStorage.organizationName
            KeyValueRow("Name", accountName ?: secureStorage.organizationId ?: "Not configured", mono = accountName == null)
            secureStorage.accountType?.let { type ->
                HairlineDivider()
                KeyValueRow("Type", if (type == "PERSONAL") "Personal" else "Business")
            }
        }

        Spacer(modifier = Modifier.height(24.dp))

        // Device
        SectionLabel("Device")
        BriskCard(modifier = Modifier.fillMaxWidth(), contentPadding = rowsPadding) {
            KeyValueRow("Device ID", secureStorage.deviceId ?: "Unassigned", mono = true)
            HairlineDivider()
            KeyValueRow("Model", "${Build.MANUFACTURER} ${Build.MODEL}")
            HairlineDivider()
            KeyValueRow("Android", "${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})")
            HairlineDivider()
            KeyValueRow("App version", tz.co.brisksms.BuildConfig.VERSION_NAME)
        }

        Spacer(modifier = Modifier.height(24.dp))

        // Endpoints: shown only when this phone is not on the standard BriskSMS server
        val customApi = secureStorage.apiBaseUrl != KeystoreSecureStorage.DEFAULT_API_BASE_URL
        val externalRelay = secureStorage.gatewayMode != "MANAGED_GATEWAY"
        if (customApi || externalRelay) {
            SectionLabel("Servers")
            BriskCard(modifier = Modifier.fillMaxWidth()) {
                if (customApi) {
                    Text("API", style = MaterialTheme.typography.bodySmall, color = BriskColors.textSecondary())
                    Spacer(modifier = Modifier.height(4.dp))
                    Text(secureStorage.apiBaseUrl, style = BriskMonoStyle, color = BriskColors.textPrimary())
                }
                if (externalRelay) {
                    if (customApi) {
                        Spacer(modifier = Modifier.height(12.dp))
                        HairlineDivider()
                        Spacer(modifier = Modifier.height(12.dp))
                    }
                    Text("SMSGate", style = MaterialTheme.typography.bodySmall, color = BriskColors.textSecondary())
                    Spacer(modifier = Modifier.height(4.dp))
                    Text(secureStorage.smsGateBaseUrl, style = BriskMonoStyle, color = BriskColors.textPrimary())
                }
            }

            Spacer(modifier = Modifier.height(24.dp))
        }

        // App lock uses the phone's own PIN, pattern, password or fingerprint
        SectionLabel("Security")
        BriskCard(modifier = Modifier.fillMaxWidth(), contentPadding = PaddingValues(0.dp)) {
            ActionRow(
                icon = R.drawable.ic_lock,
                text = "Lock with screen lock",
                status = { StatusTag(if (appLockEnabled) StatusKind.Positive else StatusKind.Neutral, if (appLockEnabled) "On" else "Off") },
                onClick = {
                    val keyguard = context.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
                    if (!appLockEnabled && !keyguard.isDeviceSecure) {
                        showNeedsScreenLock = true
                    } else {
                        showNeedsScreenLock = false
                        appLockEnabled = !appLockEnabled
                        secureStorage.isAppLockEnabled = appLockEnabled
                    }
                }
            )
        }
        Spacer(modifier = Modifier.height(8.dp))
        Text(
            if (showNeedsScreenLock) "Set a PIN, pattern or password in Android settings first, then turn this on."
            else "Asks for your phone's screen lock when the app opens and after a minute away. Payments and messages keep running while it is locked.",
            style = MaterialTheme.typography.bodySmall,
            color = if (showNeedsScreenLock) BriskColors.negativeInk() else BriskColors.textSecondary(),
            modifier = Modifier.padding(horizontal = 4.dp)
        )

        Spacer(modifier = Modifier.height(24.dp))

        // Optional end-of-day notification, counts only
        SectionLabel("Notifications")
        BriskCard(modifier = Modifier.fillMaxWidth(), contentPadding = PaddingValues(0.dp)) {
            ActionRow(
                icon = R.drawable.ic_bell,
                text = "Daily summary at 18:00",
                status = { StatusTag(if (dailySummaryEnabled) StatusKind.Positive else StatusKind.Neutral, if (dailySummaryEnabled) "On" else "Off") },
                onClick = {
                    dailySummaryEnabled = !dailySummaryEnabled
                    secureStorage.isDailySummaryEnabled = dailySummaryEnabled
                    DailySummaryWorker.schedule(context, dailySummaryEnabled)
                }
            )
        }
        Spacer(modifier = Modifier.height(8.dp))
        Text(
            "Once a day, how many payment texts and messages this phone handled. Only counts, never message text.",
            style = MaterialTheme.typography.bodySmall,
            color = BriskColors.textSecondary(),
            modifier = Modifier.padding(horizontal = 4.dp)
        )

        Spacer(modifier = Modifier.height(24.dp))

        // Android permissions
        SectionLabel("Permissions")
        BriskCard(modifier = Modifier.fillMaxWidth(), contentPadding = PaddingValues(0.dp)) {
            ActionRow(
                icon = R.drawable.ic_bell,
                text = "Notification access",
                onClick = {
                    context.startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
                }
            )
            HairlineDivider(modifier = Modifier.padding(start = 58.dp))
            ActionRow(
                icon = R.drawable.ic_smartphone,
                text = "SMS and phone permissions",
                onClick = {
                    val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                        data = Uri.fromParts("package", context.packageName, null)
                    }
                    context.startActivity(intent)
                }
            )
            HairlineDivider(modifier = Modifier.padding(start = 58.dp))
            ActionRow(
                icon = R.drawable.ic_battery,
                text = "Battery optimization",
                onClick = {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                        val intent = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
                        context.startActivity(intent)
                    }
                }
            )
            HairlineDivider(modifier = Modifier.padding(start = 58.dp))
            ActionRow(
                icon = R.drawable.ic_battery,
                text = "Keep running in the background",
                onClick = { showBackgroundGuide = true }
            )
        }

        Spacer(modifier = Modifier.height(24.dp))

        AppUpdateSection()

        Spacer(modifier = Modifier.height(24.dp))

        // Support, privacy and terms
        SectionLabel("Support and legal")
        BriskCard(modifier = Modifier.fillMaxWidth(), contentPadding = PaddingValues(0.dp)) {
            ActionRow(
                icon = R.drawable.ic_lock,
                text = "Privacy policy (PDPA Tanzania)",
                trailingIcon = R.drawable.ic_external_link,
                onClick = {
                    val intent = Intent(Intent.ACTION_VIEW, Uri.parse("https://brisksms.app/#privacy"))
                    runCatching { context.startActivity(intent) }
                }
            )
            HairlineDivider(modifier = Modifier.padding(start = 58.dp))
            ActionRow(
                icon = R.drawable.ic_file_text,
                text = "Terms of service and TCRA rules",
                trailingIcon = R.drawable.ic_external_link,
                onClick = {
                    val intent = Intent(Intent.ACTION_VIEW, Uri.parse("https://brisksms.app/#terms"))
                    runCatching { context.startActivity(intent) }
                }
            )
            HairlineDivider(modifier = Modifier.padding(start = 58.dp))
            ActionRow(
                icon = R.drawable.ic_file_text,
                text = "Share diagnostics with support",
                trailingIcon = R.drawable.ic_external_link,
                onClick = {
                    coroutineScope.launch {
                        val report = withContext(Dispatchers.IO) { SupportBundle.build(context) }
                        val send = Intent(Intent.ACTION_SEND).apply {
                            type = "text/plain"
                            putExtra(Intent.EXTRA_SUBJECT, "BriskSMS diagnostics")
                            putExtra(Intent.EXTRA_TEXT, report)
                        }
                        runCatching { context.startActivity(Intent.createChooser(send, "Share diagnostics")) }
                    }
                }
            )
            HairlineDivider(modifier = Modifier.padding(start = 58.dp))
            ActionRow(
                icon = R.drawable.ic_mail,
                text = "Contact enterprise support",
                trailingIcon = R.drawable.ic_external_link,
                onClick = {
                    val intent = Intent(Intent.ACTION_VIEW, Uri.parse("mailto:enterprise@brisksms.app"))
                    runCatching { context.startActivity(intent) }
                }
            )
        }

        Spacer(modifier = Modifier.height(32.dp))

        // Disconnect / unpair
        SecondaryPillButton(
            text = "Unpair this phone",
            icon = R.drawable.ic_log_out,
            contentColor = BriskColors.negativeInk(),
            onClick = { showDisconnectDialog = true }
        )
    }

    if (showBackgroundGuide) {
        val guide = BackgroundGuide.forManufacturer(Build.MANUFACTURER)
        AlertDialog(
            onDismissRequest = { showBackgroundGuide = false },
            containerColor = BriskColors.cardContainer(),
            shape = BriskShapes.large,
            title = { Text(if (guide.maker == "your phone") "Keep BriskSMS running" else "Keep BriskSMS running on ${guide.maker}") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text("Some phones stop background apps to save battery, which pauses payment capture and the relay. These steps usually fix it, though menu names vary between versions.")
                    guide.steps.forEachIndexed { index, step ->
                        Text("${index + 1}. $step", style = MaterialTheme.typography.bodyMedium)
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = { showBackgroundGuide = false }) { Text("Done", color = BriskColors.accentInk()) }
            }
        )
    }

    if (showDisconnectDialog) {
        suspend fun unpairLocally() {
            // Stop relay service
            val stopIntent = Intent(context, SmsGateRelayService::class.java).apply {
                action = SmsGateRelayService.ACTION_STOP
            }
            context.stopService(stopIntent)

            // Cancel background workers
            WorkManager.getInstance(context).cancelAllWork()

            // Clear local Room tables, secure storage, and wipe local hardware identity key
            withContext(Dispatchers.IO) {
                BriskDatabase.getInstance(context).clearAllTables()
            }
            secureStorage.clear()
            runCatching { KeystoreManager().deleteKey() }

            withContext(Dispatchers.Main) {
                onUnpaired()
            }
        }

        AlertDialog(
            onDismissRequest = {
                if (!isUnpairing) {
                    showDisconnectDialog = false
                    unpairError = false
                }
            },
            containerColor = BriskColors.cardContainer(),
            shape = BriskShapes.large,
            title = { Text("Unpair this phone?") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text("Gateway services stop, hardware keys are wiped and local tokens are removed. The phone stops relaying until it is paired again.")
                    if (unpairError) {
                        Text(
                            "The server could not be reached, so this phone would still use a device slot on your plan. Check the connection and try again, or unpair anyway and remove the phone later in the web console.",
                            style = MaterialTheme.typography.bodySmall,
                            color = BriskColors.negativeInk()
                        )
                    }
                }
            },
            confirmButton = {
                TextButton(
                    enabled = !isUnpairing,
                    onClick = {
                        isUnpairing = true
                        unpairError = false
                        coroutineScope.launch {
                            val told = withContext(Dispatchers.IO) { BriskApiClient(secureStorage).disconnectDevice() }
                            if (told.isSuccess) {
                                unpairLocally()
                            } else {
                                isUnpairing = false
                                unpairError = true
                            }
                        }
                    }
                ) {
                    Text(
                        when {
                            isUnpairing -> "Unpairing"
                            unpairError -> "Try again"
                            else -> "Unpair"
                        },
                        color = BriskColors.negativeInk()
                    )
                }
            },
            dismissButton = {
                TextButton(
                    enabled = !isUnpairing,
                    onClick = {
                        if (unpairError) {
                            coroutineScope.launch { unpairLocally() }
                        } else {
                            showDisconnectDialog = false
                        }
                    }
                ) {
                    Text(if (unpairError) "Unpair anyway" else "Cancel")
                }
            }
        )
    }
}
