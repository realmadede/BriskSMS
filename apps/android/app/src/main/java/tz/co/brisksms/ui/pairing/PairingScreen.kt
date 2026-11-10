package tz.co.brisksms.ui.pairing

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
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
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import tz.co.brisksms.core.network.BriskApiClient
import tz.co.brisksms.core.network.PairDeviceRequest
import tz.co.brisksms.core.storage.KeystoreSecureStorage
import tz.co.brisksms.messaging.service.SmsGateRelayService
import tz.co.brisksms.security.KeystoreManager
import tz.co.brisksms.ui.theme.BriskColors
import tz.co.brisksms.ui.theme.BriskShapes
import tz.co.brisksms.worker.TelemetryWorker
import java.util.concurrent.TimeUnit

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
        var endpoint: String? = null

        // Attempt to parse QR JSON format
        if (cleanInput.startsWith("{") && cleanInput.endsWith("}")) {
            try {
                val json = JSONObject(cleanInput)
                token = json.optString("token", cleanInput)
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

        // Clean endpoint format: strip /v1 if present to maintain base URL standard
        if (endpoint != null && endpoint.isNotBlank()) {
            val cleaned = endpoint.trimEnd('/').removeSuffix("/v1")
            secureStorage.apiBaseUrl = cleaned
        }

        isEnrolling = true
        errorMessage = null

        coroutineScope.launch {
            try {
                val publicKeyBase64 = withContext(Dispatchers.IO) {
                    keystoreManager.getPublicKeyBase64()
                }

                val request = PairDeviceRequest(
                    enrollmentToken = token,
                    label = deviceLabel.ifBlank { "${Build.MANUFACTURER} ${Build.MODEL}" },
                    publicKeyPem = publicKeyBase64,
                    deviceModel = Build.MODEL,
                    manufacturer = Build.MANUFACTURER,
                    androidVersion = Build.VERSION.RELEASE,
                    appVersion = "1.0.0"
                )

                val result = withContext(Dispatchers.IO) {
                    apiClient.pairDevice(request)
                }

                if (result.isSuccess) {
                    val data = result.getOrThrow()
                    secureStorage.deviceToken = data.deviceToken
                    secureStorage.deviceId = data.deviceId
                    secureStorage.organizationId = data.organizationId
                    secureStorage.isPaired = true
                    secureStorage.isRevoked = false

                    // Schedule periodic device telemetry
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

    // Full-screen camera viewfinder if active
    if (isScanningActive) {
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
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(BriskColors.CanvasBaseLight)
            .padding(24.dp)
            .verticalScroll(rememberScrollState()),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        // Security Badge
        Surface(
            shape = BriskShapes.extraLarge,
            color = if (isHardwareSecured) BriskColors.StatusVerified.copy(alpha = 0.15f) else BriskColors.StatusReview.copy(alpha = 0.15f),
            modifier = Modifier.padding(bottom = 16.dp)
        ) {
            Row(
                modifier = Modifier.padding(horizontal = 14.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp)
            ) {
                Box(
                    modifier = Modifier
                        .size(8.dp)
                        .background(
                            if (isHardwareSecured) BriskColors.StatusVerified else BriskColors.StatusReview,
                            CircleShape
                        )
                )
                Text(
                    text = if (isHardwareSecured) "Hardware Keystore (TEE/StrongBox)" else "Standard Keystore",
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = if (isHardwareSecured) BriskColors.StatusVerified else BriskColors.StatusReview
                )
            }
        }

        Text(
            text = "Pair Business Relay",
            fontSize = 24.sp,
            fontWeight = FontWeight.Bold,
            color = BriskColors.TextPrimaryLight,
            modifier = Modifier.padding(bottom = 8.dp)
        )

        Text(
            text = "Scan the QR code from the BriskSMS Web Console to authorize this Android handset as a secure gateway node.",
            fontSize = 14.sp,
            color = BriskColors.TextSecondaryLight,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp)
        )

        Spacer(modifier = Modifier.height(24.dp))

        // Primary Action: Camera QR Scanner Button
        Button(
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
            enabled = !isEnrolling,
            shape = BriskShapes.extraLarge,
            colors = ButtonDefaults.buttonColors(
                containerColor = Color(0xFFE5853B), // BriskSMS Contrast Pill / Primary Accent
                contentColor = Color.White
            ),
            modifier = Modifier
                .fillMaxWidth()
                .height(52.dp)
        ) {
            Text(
                text = "Scan Dashboard QR Code",
                fontSize = 15.sp,
                fontWeight = FontWeight.Bold
            )
        }

        Spacer(modifier = Modifier.height(20.dp))

        // Separator
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Divider(modifier = Modifier.weight(1f), color = BriskColors.BorderHairlineLight)
            Text(
                text = "OR ENTER MANUALLY",
                fontSize = 11.sp,
                fontWeight = FontWeight.Bold,
                color = BriskColors.TextTertiaryLight,
                modifier = Modifier.padding(horizontal = 12.dp)
            )
            Divider(modifier = Modifier.weight(1f), color = BriskColors.BorderHairlineLight)
        }

        Spacer(modifier = Modifier.height(16.dp))

        OutlinedTextField(
            value = inputPayload,
            onValueChange = { inputPayload = it },
            label = { Text("Pairing Token or QR JSON") },
            placeholder = { Text("bsk_pair_... or {\"token\":...}") },
            shape = BriskShapes.medium,
            singleLine = false,
            maxLines = 3,
            modifier = Modifier.fillMaxWidth()
        )

        Spacer(modifier = Modifier.height(12.dp))

        OutlinedTextField(
            value = deviceLabel,
            onValueChange = { deviceLabel = it },
            label = { Text("Device Label (Optional)") },
            placeholder = { Text("e.g. Dar Office Gateway #1") },
            shape = BriskShapes.medium,
            singleLine = true,
            modifier = Modifier.fillMaxWidth()
        )

        Spacer(modifier = Modifier.height(12.dp))

        // Advanced Configuration toggle
        TextButton(
            onClick = { isAdvancedOpen = !isAdvancedOpen },
            modifier = Modifier.align(Alignment.Start)
        ) {
            Text(
                text = if (isAdvancedOpen) "Hide Server Options" else "Custom Server Options",
                fontSize = 12.sp,
                color = BriskColors.TextSecondaryLight
            )
        }

        if (isAdvancedOpen) {
            OutlinedTextField(
                value = customEndpoint,
                onValueChange = { customEndpoint = it },
                label = { Text("Custom API Base URL") },
                placeholder = { Text("https://api.brisksms.co.tz") },
                shape = BriskShapes.medium,
                singleLine = true,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(bottom = 8.dp)
            )
        }

        if (errorMessage != null) {
            Text(
                text = errorMessage ?: "",
                color = BriskColors.StatusRejected,
                fontSize = 13.sp,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(vertical = 8.dp)
            )
        }

        Spacer(modifier = Modifier.height(16.dp))

        OutlinedButton(
            onClick = {
                startPairingFlow(inputPayload)
            },
            enabled = !isEnrolling && inputPayload.isNotBlank(),
            shape = BriskShapes.extraLarge,
            modifier = Modifier
                .fillMaxWidth()
                .height(48.dp)
        ) {
            if (isEnrolling) {
                CircularProgressIndicator(color = BriskColors.ContrastPill, modifier = Modifier.size(22.dp))
            } else {
                Text(text = "Connect with Token", fontWeight = FontWeight.SemiBold)
            }
        }
    }
}
