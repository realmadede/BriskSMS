package tz.co.brisksms.ui.pairing

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import tz.co.brisksms.core.network.BriskApiClient
import tz.co.brisksms.core.storage.KeystoreSecureStorage
import tz.co.brisksms.messaging.service.SmsGateRelayService
import tz.co.brisksms.security.DeviceKeyProvider
import tz.co.brisksms.security.DevicePairingCoordinator
import tz.co.brisksms.security.KeystoreManager
import tz.co.brisksms.security.PairingCompletionPayload
import tz.co.brisksms.security.PairingStateSink
import tz.co.brisksms.R
import tz.co.brisksms.ui.components.BriskCard
import tz.co.brisksms.ui.components.BriskMark
import tz.co.brisksms.ui.components.HairlineDivider
import tz.co.brisksms.ui.components.PerforatedDivider
import tz.co.brisksms.ui.components.PrimaryPillButton
import tz.co.brisksms.ui.components.ScreenPadding
import tz.co.brisksms.ui.components.SecondaryPillButton
import tz.co.brisksms.ui.components.StatusKind
import tz.co.brisksms.ui.components.StatusTag
import tz.co.brisksms.ui.theme.BriskColors
import tz.co.brisksms.ui.theme.BriskMonoStyle
import tz.co.brisksms.ui.theme.BriskShapes
import tz.co.brisksms.worker.TelemetryWorker
import java.util.concurrent.TimeUnit

object PairingUrlValidator {
    fun normalizeAndValidateHttpsBaseUrl(rawUrl: String): String {
        val trimmed = rawUrl.trim().trimEnd('/').removeSuffix("/v1")
        val uri = java.net.URI.create(trimmed)
        val host = uri.host?.lowercase() ?: ""
        val isHttps = "https".equals(uri.scheme, ignoreCase = true)
        val isLocalDebugLoopback = tz.co.brisksms.BuildConfig.DEBUG &&
            "http".equals(uri.scheme, ignoreCase = true) &&
            (host == "127.0.0.1" || host == "localhost" || host == "10.0.2.2")
        if ((!isHttps && !isLocalDebugLoopback) || host.isBlank()) {
            throw IllegalArgumentException("Server endpoint must use a valid HTTPS URL (cleartext HTTP is prohibited).")
        }
        return trimmed
    }
}

@Composable
fun PairingScreen(
    onPairingSuccess: () -> Unit
) {
    val context = LocalContext.current
    val coroutineScope = rememberCoroutineScope()

    var inputPayload by remember { mutableStateOf("") }
    var deviceLabel by remember { mutableStateOf("") }
    var customEndpoint by remember { mutableStateOf("") }
    var isAdvancedOpen by remember { mutableStateOf(false) }
    var isEnrolling by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var isScanningActive by remember { mutableStateOf(false) }

    val keystoreManager = remember { KeystoreManager() }
    val isHardwareSecured = remember { keystoreManager.isHardwareBacked() }
    val secureStorage = remember { KeystoreSecureStorage(context) }
    val apiClient = remember { BriskApiClient(secureStorage) }
    val pairingCoordinator = remember {
        DevicePairingCoordinator(
            keyProvider = object : DeviceKeyProvider {
                override fun getPublicKeyPem(): String = keystoreManager.getPublicKeyPem()
                override fun getPublicKeyFingerprintHex(): String = keystoreManager.getPublicKeyFingerprintHex()
                override fun sign(data: ByteArray): String = keystoreManager.sign(data)
            },
            transport = apiClient,
            stateSink = object : PairingStateSink {
                override fun persistEnrolledDevice(result: PairingCompletionPayload) {
                    secureStorage.deviceToken = result.deviceToken
                    secureStorage.deviceId = result.deviceId
                    secureStorage.organizationId = result.organizationId
                    secureStorage.organizationName = result.organizationName.ifBlank { null }
                    secureStorage.accountType = result.accountType.ifBlank { null }
                    secureStorage.isPaired = true
                    secureStorage.isRevoked = false
                }
            }
        )
    }

    val cameraPermissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission()
    ) { isGranted ->
        if (isGranted) {
            errorMessage = null
            isScanningActive = true
        } else {
            errorMessage = "Camera permission is required to scan pairing QR codes. You can enter the pairing code manually below."
            isScanningActive = false
        }
    }

    fun startPairingFlow(rawInput: String) {
        val cleanInput = rawInput.trim()
        if (cleanInput.isEmpty()) {
            errorMessage = "Please enter a pairing code or scan a QR code"
            return
        }

        var token = cleanInput
        var expectedOrgId: String? = null
        var endpoint: String? = null

        // Attempt to parse QR JSON format
        if (cleanInput.startsWith("{") && cleanInput.endsWith("}")) {
            try {
                val json = JSONObject(cleanInput)
                token = json.optString("token", cleanInput)
                expectedOrgId = json.optString("org", "").ifBlank { null }
                if (json.has("endpoint")) {
                    endpoint = json.getString("endpoint")
                }

                // Security Check: Verify 5-minute single-use token expiry claim if present
                val expStr = json.optString("exp", "")
                if (expStr.isNotEmpty()) {
                    try {
                        val expMillis = java.time.Instant.parse(expStr).toEpochMilli()
                        if (System.currentTimeMillis() > expMillis) {
                            errorMessage = "This pairing QR code has expired (5-minute limit). Please refresh the code on your Web Console."
                            return
                        }
                    } catch (e: Exception) {
                        // If unparseable date, allow backend authoritative validation
                    }
                }
            } catch (e: Exception) {
                // Treat as manual token if parsing fails
            }
        }

        if (customEndpoint.isNotBlank()) {
            endpoint = customEndpoint.trim()
        }

        // Enforce HTTPS-only API endpoint and strip /v1 if present to maintain base URL standard
        if (endpoint != null && endpoint.isNotBlank()) {
            try {
                secureStorage.apiBaseUrl = PairingUrlValidator.normalizeAndValidateHttpsBaseUrl(endpoint)
            } catch (e: Exception) {
                errorMessage = e.message ?: "Invalid server endpoint URL"
                return
            }
        }

        isEnrolling = true
        errorMessage = null

        coroutineScope.launch {
            try {
                val result = withContext(Dispatchers.IO) {
                    if (secureStorage.isRevoked && !secureStorage.isPaired) {
                        // Rotate away any revoked hardware key before explicit operator re-enrollment
                        runCatching { keystoreManager.deleteKey() }
                    }
                    pairingCoordinator.enroll(
                        enrollmentToken = token,
                        expectedOrganizationId = expectedOrgId,
                        label = deviceLabel.ifBlank { "${Build.MANUFACTURER} ${Build.MODEL}" },
                        deviceModel = Build.MODEL,
                        manufacturer = Build.MANUFACTURER,
                        androidVersion = Build.VERSION.RELEASE,
                        appVersion = tz.co.brisksms.BuildConfig.VERSION_NAME
                    )
                }

                if (result.isSuccess) {
                    // Schedule periodic device telemetry only after backend confirmed enrollment
                    val telemetryRequest = PeriodicWorkRequestBuilder<TelemetryWorker>(
                        15, TimeUnit.MINUTES
                    ).build()
                    WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                        "BrisksmsTelemetry",
                        ExistingPeriodicWorkPolicy.KEEP,
                        telemetryRequest
                    )

                    // Start SMSGate Relay if bulk messaging is enabled
                    if (secureStorage.isBulkMessagingEnabled) {
                        val serviceIntent = Intent(context, SmsGateRelayService::class.java).apply {
                            action = SmsGateRelayService.ACTION_START
                        }
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                            context.startForegroundService(serviceIntent)
                        } else {
                            context.startService(serviceIntent)
                        }
                    }

                    onPairingSuccess()
                } else {
                    errorMessage = result.exceptionOrNull()?.message ?: "Pairing failed"
                    isEnrolling = false
                }
            } catch (e: Exception) {
                errorMessage = "Error during pairing: ${e.message}"
                isEnrolling = false
            }
        }
    }

    LaunchedEffect(Unit) {
        if (tz.co.brisksms.BuildConfig.DEBUG) {
            val debugPayload = (context as? android.app.Activity)?.intent?.getStringExtra("debug_pair_payload")
            if (!debugPayload.isNullOrBlank()) {
                (context as? android.app.Activity)?.intent?.removeExtra("debug_pair_payload")
                inputPayload = debugPayload
                startPairingFlow(debugPayload)
            }
        }
    }

    // Full-screen camera viewfinder if active
    if (isScanningActive) {
        BackHandler(enabled = true) {
            isScanningActive = false
        }
        QrCameraScanner(
            onQrScanned = { scannedPayload ->
                isScanningActive = false
                inputPayload = scannedPayload
                startPairingFlow(scannedPayload)
            },
            onCancel = {
                isScanningActive = false
            }
        )
        return
    }

    // Default Enrollment / Manual Entry View
    val fieldColors = OutlinedTextFieldDefaults.colors(
        focusedContainerColor = BriskColors.cardContainer(),
        unfocusedContainerColor = BriskColors.cardContainer(),
        disabledContainerColor = BriskColors.cardContainer()
    )

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(BriskColors.canvasBase())
            .systemBarsPadding()
            .imePadding()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = ScreenPadding, vertical = 24.dp)
    ) {
        // Brand and key security
        Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            BriskMark(size = 28.dp)
            Spacer(modifier = Modifier.width(8.dp))
            Text(
                text = "BriskSMS",
                style = MaterialTheme.typography.titleMedium,
                color = BriskColors.textPrimary(),
                modifier = Modifier.weight(1f)
            )
            StatusTag(
                kind = if (isHardwareSecured) StatusKind.Positive else StatusKind.Review,
                text = if (isHardwareSecured) "Hardware keystore" else "Standard keystore"
            )
        }

        Spacer(modifier = Modifier.height(32.dp))

        Text(
            text = "Pair this phone",
            style = MaterialTheme.typography.headlineSmall,
            color = BriskColors.textPrimary()
        )
        Spacer(modifier = Modifier.height(4.dp))
        Text(
            text = "Scan the QR code from the BriskSMS web console to authorize this phone as your business relay",
            style = MaterialTheme.typography.bodyMedium,
            color = BriskColors.textSecondary()
        )

        Spacer(modifier = Modifier.height(24.dp))

        // Pairing slip
        BriskCard(modifier = Modifier.fillMaxWidth(), contentPadding = PaddingValues(0.dp)) {
            PairingCodeTarget(
                modifier = Modifier
                    .align(Alignment.CenterHorizontally)
                    .padding(top = 24.dp, bottom = 16.dp)
            )
            PerforatedDivider()
            PrimaryPillButton(
                text = "Scan QR code",
                icon = R.drawable.ic_scan_line,
                enabled = !isEnrolling,
                onClick = {
                    val hasPermission = ContextCompat.checkSelfPermission(
                        context,
                        Manifest.permission.CAMERA
                    ) == PackageManager.PERMISSION_GRANTED

                    if (hasPermission) {
                        errorMessage = null
                        isScanningActive = true
                    } else {
                        cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
                    }
                },
                modifier = Modifier.padding(16.dp)
            )
        }

        Spacer(modifier = Modifier.height(24.dp))

        // Manual entry
        Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            HairlineDivider(modifier = Modifier.weight(1f))
            Text(
                text = "Or enter the code",
                style = MaterialTheme.typography.labelMedium,
                color = BriskColors.textSecondary(),
                modifier = Modifier.padding(horizontal = 12.dp)
            )
            HairlineDivider(modifier = Modifier.weight(1f))
        }

        Spacer(modifier = Modifier.height(16.dp))

        OutlinedTextField(
            value = inputPayload,
            onValueChange = { inputPayload = it },
            label = { Text("Pairing code or QR JSON") },
            placeholder = { Text("bsk_pair_…", style = BriskMonoStyle) },
            textStyle = BriskMonoStyle.copy(color = BriskColors.textPrimary()),
            shape = BriskShapes.medium,
            colors = fieldColors,
            singleLine = false,
            maxLines = 3,
            modifier = Modifier.fillMaxWidth()
        )

        Spacer(modifier = Modifier.height(12.dp))

        OutlinedTextField(
            value = deviceLabel,
            onValueChange = { deviceLabel = it },
            label = { Text("Device label (optional)") },
            placeholder = { Text("Dar office gateway 1") },
            shape = BriskShapes.medium,
            colors = fieldColors,
            singleLine = true,
            modifier = Modifier.fillMaxWidth()
        )

        Spacer(modifier = Modifier.height(4.dp))

        // Custom server toggle
        TextButton(
            onClick = { isAdvancedOpen = !isAdvancedOpen },
            contentPadding = PaddingValues(horizontal = 0.dp),
            colors = ButtonDefaults.textButtonColors(contentColor = BriskColors.accentInk())
        ) {
            Text(
                text = if (isAdvancedOpen) "Hide custom server" else "Use a custom server",
                style = MaterialTheme.typography.labelMedium
            )
            Spacer(modifier = Modifier.width(4.dp))
            Icon(
                painter = painterResource(R.drawable.ic_chevron_down),
                contentDescription = null,
                modifier = Modifier
                    .size(16.dp)
                    .rotate(if (isAdvancedOpen) 180f else 0f)
            )
        }

        if (isAdvancedOpen) {
            OutlinedTextField(
                value = customEndpoint,
                onValueChange = { customEndpoint = it },
                label = { Text("API base URL") },
                placeholder = { Text("https://api.brisksms.app", style = BriskMonoStyle) },
                textStyle = BriskMonoStyle.copy(color = BriskColors.textPrimary()),
                shape = BriskShapes.medium,
                colors = fieldColors,
                singleLine = true,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(bottom = 8.dp)
            )
        }

        if (errorMessage != null) {
            Row(
                modifier = Modifier.padding(vertical = 8.dp),
                verticalAlignment = Alignment.Top
            ) {
                Icon(
                    painter = painterResource(R.drawable.ic_circle_x),
                    contentDescription = null,
                    tint = BriskColors.StatusRejected,
                    modifier = Modifier
                        .padding(top = 1.dp)
                        .size(16.dp)
                )
                Spacer(modifier = Modifier.width(8.dp))
                Text(
                    text = errorMessage ?: "",
                    style = MaterialTheme.typography.bodySmall,
                    color = BriskColors.textPrimary()
                )
            }
        }

        Spacer(modifier = Modifier.height(16.dp))

        SecondaryPillButton(
            text = "Connect with code",
            onClick = { startPairingFlow(inputPayload) },
            enabled = inputPayload.isNotBlank(),
            loading = isEnrolling
        )
    }
}

/**
 * The pairing slip's visual: a QR code inside scan brackets with the BriskSMS mark at its center.
 * Illustrative only; the real code is generated by the web console.
 */
@Composable
private fun PairingCodeTarget(modifier: Modifier = Modifier) {
    val ink = BriskColors.textPrimary()
    val paper = BriskColors.cardContainer()
    val bracket = BriskColors.textTertiary()
    val modules = remember {
        val random = java.util.Random(20261117L)
        BooleanArray(21 * 21) { random.nextInt(100) < 45 }
    }

    Box(modifier = modifier.size(144.dp), contentAlignment = Alignment.Center) {
        Canvas(modifier = Modifier.fillMaxSize()) {
            val stroke = 2.dp.toPx()
            val arm = 20.dp.toPx()
            val lo = stroke / 2
            val hi = size.width - stroke / 2
            listOf(
                Triple(lo, lo, 1f to 1f),
                Triple(hi, lo, -1f to 1f),
                Triple(lo, hi, 1f to -1f),
                Triple(hi, hi, -1f to -1f)
            ).forEach { (x, y, dir) ->
                drawLine(bracket, Offset(x, y), Offset(x + dir.first * arm, y), stroke, cap = StrokeCap.Round)
                drawLine(bracket, Offset(x, y), Offset(x, y + dir.second * arm), stroke, cap = StrokeCap.Round)
            }

            val cell = 5.dp.toPx()
            val origin = (size.width - cell * 21) / 2
            fun isFinder(r: Int, c: Int) = (r < 8 && c < 8) || (r < 8 && c > 12) || (r > 12 && c < 8)
            fun isCenter(r: Int, c: Int) = r in 7..13 && c in 7..13
            for (r in 0 until 21) for (c in 0 until 21) {
                if (isFinder(r, c) || isCenter(r, c) || !modules[r * 21 + c]) continue
                drawRect(ink, Offset(origin + c * cell, origin + r * cell), Size(cell, cell))
            }
            listOf(0 to 0, 0 to 14, 14 to 0).forEach { (r, c) ->
                val topLeft = Offset(origin + c * cell, origin + r * cell)
                drawRect(ink, topLeft, Size(cell * 7, cell * 7))
                drawRect(paper, topLeft + Offset(cell, cell), Size(cell * 5, cell * 5))
                drawRect(ink, topLeft + Offset(cell * 2, cell * 2), Size(cell * 3, cell * 3))
            }
        }
        BriskMark(size = 28.dp)
    }
}
