package tz.co.brisksms.ui.settings

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
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
import androidx.work.WorkManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import tz.co.brisksms.core.storage.KeystoreSecureStorage
import tz.co.brisksms.data.local.BriskDatabase
import tz.co.brisksms.messaging.service.SmsGateRelayService
import tz.co.brisksms.ui.theme.BriskColors
import tz.co.brisksms.ui.theme.BriskShapes

@Composable
fun SettingsScreen(
    onUnpaired: () -> Unit
) {
    val context = LocalContext.current
    val coroutineScope = rememberCoroutineScope()
    val secureStorage = remember { KeystoreSecureStorage(context) }
    var showDisconnectDialog by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(BriskColors.CanvasBaseLight)
            .padding(20.dp)
            .verticalScroll(rememberScrollState())
    ) {
        // Top Header
        Text(
            text = "Settings & Device Info",
            fontSize = 20.sp,
            fontWeight = FontWeight.Bold,
            color = BriskColors.TextPrimaryLight
        )
        Text(
            text = "Identity, operational endpoints, and Android permission governance",
            fontSize = 12.sp,
            color = BriskColors.TextSecondaryLight
        )

        Spacer(modifier = Modifier.height(16.dp))

        // Organization Info
        Card(
            shape = BriskShapes.large,
            colors = CardDefaults.cardColors(containerColor = Color.White),
            modifier = Modifier.fillMaxWidth()
        ) {
            Column(modifier = Modifier.padding(16.dp)) {
                Text(
                    text = "ORGANIZATION METADATA",
                    fontSize = 10.sp,
                    fontWeight = FontWeight.Bold,
                    color = BriskColors.TextTertiaryLight
                )
                Spacer(modifier = Modifier.height(8.dp))
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Text(text = "Organization ID", fontSize = 13.sp, color = BriskColors.TextSecondaryLight)
                    Text(
                        text = secureStorage.organizationId ?: "Not Configured",
                        fontSize = 13.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = BriskColors.TextPrimaryLight
                    )
                }
            }
        }

        Spacer(modifier = Modifier.height(14.dp))

        // Device Info
        Card(
            shape = BriskShapes.large,
            colors = CardDefaults.cardColors(containerColor = Color.White),
            modifier = Modifier.fillMaxWidth()
        ) {
            Column(modifier = Modifier.padding(16.dp)) {
                Text(
                    text = "DEVICE ATTRIBUTES",
                    fontSize = 10.sp,
                    fontWeight = FontWeight.Bold,
                    color = BriskColors.TextTertiaryLight
                )
                Spacer(modifier = Modifier.height(8.dp))
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Text(text = "Device ID", fontSize = 13.sp, color = BriskColors.TextSecondaryLight)
                    Text(
                        text = secureStorage.deviceId ?: "Unassigned",
                        fontSize = 12.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = BriskColors.TextPrimaryLight
                    )
                }
                Divider(modifier = Modifier.padding(vertical = 8.dp), color = BriskColors.BorderHairlineLight)
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Text(text = "Hardware Model", fontSize = 13.sp, color = BriskColors.TextSecondaryLight)
                    Text(
                        text = "${Build.MANUFACTURER} ${Build.MODEL}",
                        fontSize = 13.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = BriskColors.TextPrimaryLight
                    )
                }
                Divider(modifier = Modifier.padding(vertical = 8.dp), color = BriskColors.BorderHairlineLight)
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Text(text = "Android OS Version", fontSize = 13.sp, color = BriskColors.TextSecondaryLight)
                    Text(
                        text = "Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})",
                        fontSize = 13.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = BriskColors.TextPrimaryLight
                    )
                }
                Divider(modifier = Modifier.padding(vertical = 8.dp), color = BriskColors.BorderHairlineLight)
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Text(text = "Companion Version", fontSize = 13.sp, color = BriskColors.TextSecondaryLight)
                    Text(
                        text = "1.0.0",
                        fontSize = 13.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = BriskColors.TextPrimaryLight
                    )
                }
            }
        }

        Spacer(modifier = Modifier.height(14.dp))

        // Endpoint Configuration
        Card(
            shape = BriskShapes.large,
            colors = CardDefaults.cardColors(containerColor = Color.White),
            modifier = Modifier.fillMaxWidth()
        ) {
            Column(modifier = Modifier.padding(16.dp)) {
                Text(
                    text = "NETWORK ENDPOINTS",
                    fontSize = 10.sp,
                    fontWeight = FontWeight.Bold,
                    color = BriskColors.TextTertiaryLight
                )
                Spacer(modifier = Modifier.height(8.dp))
                Text(
                    text = "API Base URL: ${secureStorage.apiBaseUrl}",
                    fontSize = 12.sp,
                    color = BriskColors.TextSecondaryLight
                )
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = "SMSGate Base URL: ${secureStorage.smsGateBaseUrl}",
                    fontSize = 12.sp,
                    color = BriskColors.TextSecondaryLight
                )
            }
        }

        Spacer(modifier = Modifier.height(16.dp))

        // Android Permissions Management
        Text(
            text = "Permission Management",
            fontSize = 13.sp,
            fontWeight = FontWeight.Bold,
            color = BriskColors.TextPrimaryLight,
            modifier = Modifier.padding(bottom = 6.dp)
        )

        Card(
            shape = BriskShapes.large,
            colors = CardDefaults.cardColors(containerColor = Color.White),
            modifier = Modifier.fillMaxWidth()
        ) {
            Column(modifier = Modifier.padding(16.dp)) {
                OutlinedButton(
                    onClick = {
                        context.startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
                    },
                    shape = BriskShapes.medium,
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text(text = "Notification Access Settings", fontSize = 12.sp)
                }

                Spacer(modifier = Modifier.height(8.dp))

                OutlinedButton(
                    onClick = {
                        val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                            data = Uri.fromParts("package", context.packageName, null)
                        }
                        context.startActivity(intent)
                    },
                    shape = BriskShapes.medium,
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text(text = "App Permissions (SMS & Phone State)", fontSize = 12.sp)
                }

                Spacer(modifier = Modifier.height(8.dp))

                OutlinedButton(
                    onClick = {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                            val intent = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
                            context.startActivity(intent)
                        }
                    },
                    shape = BriskShapes.medium,
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text(text = "Battery Optimization Exemption", fontSize = 12.sp)
                }
            }
        }

        Spacer(modifier = Modifier.height(24.dp))

        // Disconnect / Unpair Button
        Button(
            onClick = { showDisconnectDialog = true },
            shape = BriskShapes.extraLarge,
            colors = ButtonDefaults.buttonColors(
                containerColor = BriskColors.StatusRejected,
                contentColor = Color.White
            ),
            modifier = Modifier
                .fillMaxWidth()
                .height(48.dp)
        ) {
            Text(text = "Disconnect & Unpair Device", fontWeight = FontWeight.Bold)
        }
    }

    if (showDisconnectDialog) {
        AlertDialog(
            onDismissRequest = { showDisconnectDialog = false },
            title = { Text("Unpair Relay Device") },
            text = {
                Text("This action will stop all gateway services, wipe hardware keys, and remove local tokens. The device will cease operating until re-paired.")
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        showDisconnectDialog = false
                        coroutineScope.launch {
                            // Stop relay service
                            val stopIntent = Intent(context, SmsGateRelayService::class.java).apply {
                                action = SmsGateRelayService.ACTION_STOP
                            }
                            context.stopService(stopIntent)

                            // Cancel background workers
                            WorkManager.getInstance(context).cancelAllWork()

                            // Clear storage
                            secureStorage.clear()

                            withContext(Dispatchers.Main) {
                                onUnpaired()
                            }
                        }
                    }
                ) {
                    Text("Confirm Disconnect", color = BriskColors.StatusRejected, fontWeight = FontWeight.Bold)
                }
            },
            dismissButton = {
                TextButton(onClick = { showDisconnectDialog = false }) {
                    Text("Cancel")
                }
            }
        )
    }
}
