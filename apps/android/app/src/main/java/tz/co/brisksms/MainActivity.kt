package tz.co.brisksms

import android.Manifest
import android.app.KeyguardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.DrawableRes
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import tz.co.brisksms.core.storage.KeystoreSecureStorage
import tz.co.brisksms.ui.health.DeviceHealthScreen
import tz.co.brisksms.ui.lock.AppLockScreen
import tz.co.brisksms.ui.messaging.BulkMessagingScreen
import tz.co.brisksms.ui.onboarding.WelcomeScreen
import tz.co.brisksms.ui.overview.OverviewScreen
import tz.co.brisksms.ui.pairing.PairingScreen
import tz.co.brisksms.ui.payment.PaymentIntelligenceScreen
import tz.co.brisksms.ui.settings.SettingsScreen
import tz.co.brisksms.ui.update.UpdatePromptHost
import tz.co.brisksms.update.UpdateCheckWorker
import tz.co.brisksms.update.UpdateNotifier
import tz.co.brisksms.update.UpdateReminder
import tz.co.brisksms.ui.components.GlassTab
import tz.co.brisksms.ui.components.GlassTabBar
import tz.co.brisksms.ui.components.GlassTabBarGap
import tz.co.brisksms.ui.components.GlassTabBarHeight
import tz.co.brisksms.ui.components.LocalBottomBarInset
import tz.co.brisksms.ui.theme.BriskColors
import tz.co.brisksms.ui.theme.BriskShapes
import tz.co.brisksms.ui.theme.BriskTheme

enum class NavigationTab(val label: String, @DrawableRes val icon: Int) {
    OVERVIEW("Overview", R.drawable.ic_house),
    PAYMENT("Payments", R.drawable.ic_receipt),
    MESSAGING("Messaging", R.drawable.ic_message_square),
    HEALTH("Health", R.drawable.ic_activity),
    SETTINGS("Settings", R.drawable.ic_settings)
}

class MainActivity : ComponentActivity() {

    private companion object {
        const val WELCOME_PREFS = "brisksms_welcome"
        const val KEY_WELCOME_SEEN = "welcome_seen"
        const val RELOCK_AFTER_MS = 60_000L
    }

    private val runtimePermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { offerSmsPaymentCapture() }

    // The SMS disclosure is offered once per launch, so declining it does not loop
    private var smsDisclosureShown = false
    private var showSmsDisclosure by mutableStateOf(false)

    // App lock: the phone's own screen lock, asked on open and after a minute away
    private var isLocked by mutableStateOf(false)
    private var authInProgress = false
    private var leftAtMs = 0L

    private val unlockLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        authInProgress = false
        leftAtMs = 0L
        if (result.resultCode == RESULT_OK) isLocked = false
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        // First launch shows the welcome pages, which explain the permissions before Android asks for them.
        val welcomePrefs = getSharedPreferences(WELCOME_PREFS, MODE_PRIVATE)
        val showWelcome = !welcomePrefs.getBoolean(KEY_WELCOME_SEEN, false) &&
            !KeystoreSecureStorage(applicationContext).isPaired &&
            !(BuildConfig.DEBUG && intent?.hasExtra("debug_pair_payload") == true)

        if (!showWelcome) ensureRuntimePermissions()
        if (appLockApplies()) {
            isLocked = true
            promptUnlock()
        }
        ensureBackgroundWorkersStarted()
        scheduleUpdateChecks()
        openUpdateWindowIfAsked(intent)

        setContent { BriskTheme {
            val secureStorage = remember { KeystoreSecureStorage(applicationContext) }
            var isWelcomeVisible by remember { mutableStateOf(showWelcome) }
            var isPaired by remember { mutableStateOf(secureStorage.isPaired) }
            val initialTab = remember {
                if (BuildConfig.DEBUG) {
                    intent?.getStringExtra("debug_tab")?.let { tabName ->
                        NavigationTab.values().find { it.name.equals(tabName, ignoreCase = true) }
                    } ?: NavigationTab.OVERVIEW
                } else {
                    NavigationTab.OVERVIEW
                }
            }
            var currentTab by remember { mutableStateOf(initialTab) }

            if (isWelcomeVisible) {
                WelcomeScreen(
                    onFinish = {
                        welcomePrefs.edit().putBoolean(KEY_WELCOME_SEEN, true).apply()
                        isWelcomeVisible = false
                        ensureRuntimePermissions()
                    }
                )
            } else if (!isPaired) {
                PairingScreen(
                    onPairingSuccess = {
                        isPaired = true
                        currentTab = NavigationTab.OVERVIEW
                    }
                )
            } else {
                BackHandler(enabled = currentTab != NavigationTab.OVERVIEW) {
                    currentTab = NavigationTab.OVERVIEW
                }

                Scaffold(containerColor = BriskColors.canvasBase()) { innerPadding ->
                    val tabs = NavigationTab.values()
                    val barInset = GlassTabBarHeight + GlassTabBarGap + 8.dp +
                        WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(top = innerPadding.calculateTopPadding())
                    ) {
                        CompositionLocalProvider(LocalBottomBarInset provides barInset) {
                            when (currentTab) {
                                NavigationTab.OVERVIEW -> OverviewScreen(
                                    onNavigateToPayment = { currentTab = NavigationTab.PAYMENT },
                                    onNavigateToMessaging = { currentTab = NavigationTab.MESSAGING }
                                )
                                NavigationTab.PAYMENT -> PaymentIntelligenceScreen()
                                NavigationTab.MESSAGING -> BulkMessagingScreen()
                                NavigationTab.HEALTH -> DeviceHealthScreen()
                                NavigationTab.SETTINGS -> SettingsScreen(
                                    onUnpaired = {
                                        isPaired = false
                                    }
                                )
                            }
                        }
                        GlassTabBar(
                            tabs = tabs.map { GlassTab(it.label, it.icon) },
                            selectedIndex = currentTab.ordinal,
                            onSelect = { currentTab = tabs[it] },
                            modifier = Modifier.align(Alignment.BottomCenter)
                        )
                    }
                }
            }

            if (showSmsDisclosure) {
                AlertDialog(
                    onDismissRequest = { showSmsDisclosure = false },
                    containerColor = BriskColors.cardContainer(),
                    shape = BriskShapes.large,
                    title = { Text("Allow BriskSMS to read payment texts?", style = MaterialTheme.typography.titleMedium) },
                    text = {
                        Column(
                            modifier = Modifier.verticalScroll(rememberScrollState()),
                            verticalArrangement = Arrangement.spacedBy(12.dp)
                        ) {
                            Text(
                                "BriskSMS reads incoming text messages only to find payment confirmations from supported " +
                                    "mobile money and bank senders (M-Pesa, Mixx by Yas, Airtel Money, HaloPesa, CRDB and NMB). " +
                                    "Each one is encrypted and sent to your BriskSMS account so it can be matched to an invoice.",
                                style = MaterialTheme.typography.bodyMedium
                            )
                            Text(
                                "Every other message, including personal texts and one-time codes, is ignored on this phone and is " +
                                    "never stored or uploaded. BriskSMS cannot read your message history.",
                                style = MaterialTheme.typography.bodyMedium
                            )
                            Text(
                                "You can turn this off at any time in Android settings, under Apps, BriskSMS, Permissions.",
                                style = MaterialTheme.typography.bodyMedium,
                                color = BriskColors.textSecondary()
                            )
                        }
                    },
                    confirmButton = {
                        TextButton(onClick = {
                            showSmsDisclosure = false
                            runtimePermissionLauncher.launch(arrayOf(Manifest.permission.RECEIVE_SMS))
                        }) { Text("Allow", color = BriskColors.accentInk()) }
                    },
                    dismissButton = {
                        TextButton(onClick = { showSmsDisclosure = false }) { Text("Not now") }
                    }
                )
            }

            UpdatePromptHost(enabled = !isWelcomeVisible && !showSmsDisclosure)

            if (isLocked) AppLockScreen(onUnlock = ::promptUnlock)
        } }
    }

    private fun ensureRuntimePermissions() {
        val required = mutableListOf(
            Manifest.permission.SEND_SMS,
            Manifest.permission.READ_PHONE_STATE
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            required.add(Manifest.permission.READ_PHONE_NUMBERS)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            required.add(Manifest.permission.POST_NOTIFICATIONS)
        }
        val missing = required.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isNotEmpty()) {
            runtimePermissionLauncher.launch(missing.toTypedArray())
        } else {
            offerSmsPaymentCapture()
        }
    }

    /**
     * Direct-download build only. Shows what RECEIVE_SMS is used for before Android's own permission
     * dialog, and asks for the permission only if the user accepts.
     */
    private fun offerSmsPaymentCapture() {
        if (!BuildConfig.SMS_PAYMENT_CAPTURE || smsDisclosureShown) return
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECEIVE_SMS) == PackageManager.PERMISSION_GRANTED) return
        smsDisclosureShown = true
        showSmsDisclosure = true
    }

    override fun onStop() {
        super.onStop()
        leftAtMs = SystemClock.elapsedRealtime()
    }

    override fun onStart() {
        super.onStart()
        if (!isLocked && leftAtMs != 0L && SystemClock.elapsedRealtime() - leftAtMs > RELOCK_AFTER_MS && appLockApplies()) {
            isLocked = true
            promptUnlock()
        }
    }

    // Off unless the owner turned it on; also off if the phone no longer has a screen lock, so nobody is locked out
    private fun appLockApplies(): Boolean {
        val storage = KeystoreSecureStorage(applicationContext)
        val keyguard = getSystemService(KEYGUARD_SERVICE) as KeyguardManager
        return storage.isPaired && storage.isAppLockEnabled && keyguard.isDeviceSecure
    }

    private fun promptUnlock() {
        if (authInProgress) return
        val keyguard = getSystemService(KEYGUARD_SERVICE) as KeyguardManager
        val intent = keyguard.createConfirmDeviceCredentialIntent("Unlock BriskSMS", null)
        if (intent == null) {
            isLocked = false
            return
        }
        authInProgress = true
        unlockLauncher.launch(intent)
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        setIntent(intent)
        openUpdateWindowIfAsked(intent)
    }

    // Direct build: look for a new version twice a day, even before the phone is paired
    private fun scheduleUpdateChecks() {
        if (!BuildConfig.SELF_UPDATE) return
        val request = PeriodicWorkRequestBuilder<UpdateCheckWorker>(12, TimeUnit.HOURS)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        WorkManager.getInstance(applicationContext).enqueueUniquePeriodicWork(
            "BrisksmsUpdateCheck",
            ExistingPeriodicWorkPolicy.KEEP,
            request
        )
    }

    // The owner tapped the update reminder: show the window even if "Not now" was chosen earlier
    private fun openUpdateWindowIfAsked(intent: Intent?) {
        if (BuildConfig.SELF_UPDATE && intent?.getBooleanExtra(UpdateNotifier.EXTRA_SHOW_UPDATE, false) == true) {
            UpdateReminder(applicationContext).clearSnooze()
            intent.removeExtra(UpdateNotifier.EXTRA_SHOW_UPDATE)
        }
    }

    private fun ensureBackgroundWorkersStarted() {
        val secureStorage = KeystoreSecureStorage(applicationContext)
        if (!secureStorage.isPaired || secureStorage.isRevoked) {
            return
        }

        val telemetryRequest = PeriodicWorkRequestBuilder<tz.co.brisksms.worker.TelemetryWorker>(
            15, TimeUnit.MINUTES
        ).build()
        WorkManager.getInstance(applicationContext).enqueueUniquePeriodicWork(
            "BrisksmsTelemetry",
            ExistingPeriodicWorkPolicy.KEEP,
            telemetryRequest
        )

        WorkManager.getInstance(applicationContext).enqueueUniquePeriodicWork(
            "BrisksmsRelayHealth",
            ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<tz.co.brisksms.worker.RelayHealthWorker>(30, TimeUnit.MINUTES).build()
        )

        val uploadRequest = androidx.work.OneTimeWorkRequestBuilder<tz.co.brisksms.worker.EvidenceUploadWorker>().build()
        WorkManager.getInstance(applicationContext).enqueueUniqueWork(
            "BrisksmsEvidenceUpload",
            androidx.work.ExistingWorkPolicy.KEEP,
            uploadRequest
        )

        if (secureStorage.isBulkMessagingEnabled) {
            val serviceIntent = Intent(applicationContext, tz.co.brisksms.messaging.service.SmsGateRelayService::class.java).apply {
                action = tz.co.brisksms.messaging.service.SmsGateRelayService.ACTION_START
            }
            runCatching {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    startForegroundService(serviceIntent)
                } else {
                    startService(serviceIntent)
                }
            }
        }
    }
}
