package tz.co.brisksms.ui.pairing

import android.content.Context
import android.content.Intent
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

    val keystoreManager = remember { KeystoreManager() }
    val isHardwareSecured = remember { keystoreManager.isHardwareBacked() }
    val secureStorage = remember { KeystoreSecureStorage(context) }
    val apiClient = remember { BriskApiClient(secureStorage) }

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
            text = "Paste the QR code JSON payload or enter the pairing code from your BriskSMS organization settings.",
            fontSize = 14.sp,
            color = BriskColors.TextSecondaryLight,
            modifier = Modifier.padding(bottom = 24.dp)
        )

        OutlinedTextField(
            value = inputPayload,
            onValueChange = {
                inputPayload = it
                errorMessage = null
            },
            label = { Text("Pairing Token or QR JSON") },
            placeholder = { Text("e.g. bsk_pair_... or {\"token\":...}") },
            shape = BriskShapes.medium,
            modifier = Modifier.fillMaxWidth(),
            maxLines = 4
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
                modifier = Modifier.padding(vertical = 8.dp)
            )
        }

        Spacer(modifier = Modifier.height(20.dp))

        Button(
            onClick = {
                val rawInput = inputPayload.trim()
                if (rawInput.isEmpty()) {
                    errorMessage = "Please enter a pairing code or QR JSON"
                    return@Button
                }

                var token = rawInput
                var endpoint: String? = null

                // Attempt to parse QR JSON format
                if (rawInput.startsWith("{") && rawInput.endsWith("}")) {
                    try {
                        val json = JSONObject(rawInput)
                        token = json.optString("token", rawInput)
                        if (json.has("endpoint")) {
                            endpoint = json.getString("endpoint")
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
            },
            enabled = !isEnrolling && inputPayload.isNotBlank(),
            shape = BriskShapes.extraLarge,
            colors = ButtonDefaults.buttonColors(
                containerColor = BriskColors.ContrastPill,
                contentColor = Color.White
            ),
            modifier = Modifier
                .fillMaxWidth()
                .height(50.dp)
        ) {
            if (isEnrolling) {
                CircularProgressIndicator(color = Color.White, modifier = Modifier.size(24.dp))
            } else {
                Text(text = "Connect Device", fontWeight = FontWeight.SemiBold)
            }
        }
    }
}
