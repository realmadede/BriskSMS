package tz.co.brisksms.ui.pairing

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import tz.co.brisksms.security.KeystoreManager
import tz.co.brisksms.ui.theme.BriskColors
import tz.co.brisksms.ui.theme.BriskShapes

@Composable
fun PairingScreen(
    onPairingSuccess: () -> Unit
) {
    var pairingToken by remember { mutableStateOf("") }
    var isEnrolling by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }

    val keystoreManager = remember { KeystoreManager() }
    val isHardwareSecured = remember { keystoreManager.isHardwareBacked() }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(BriskColors.CanvasBaseLight)
            .padding(24.dp),
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
            text = "Enter the 8-character pairing code from your BriskSMS organization settings to register this device's cryptographic identity.",
            fontSize = 14.sp,
            color = BriskColors.TextSecondaryLight,
            modifier = Modifier.padding(bottom = 24.dp)
        )

        OutlinedTextField(
            value = pairingToken,
            onValueChange = { pairingToken = it.uppercase().take(8) },
            label = { Text("Pairing Token") },
            placeholder = { Text("e.g. BRK-8821") },
            shape = BriskShapes.medium,
            singleLine = true,
            modifier = Modifier.fillMaxWidth()
        )

        if (errorMessage != null) {
            Text(
                text = errorMessage ?: "",
                color = BriskColors.StatusRejected,
                fontSize = 13.sp,
                modifier = Modifier.padding(top = 8.dp)
            )
        }

        Spacer(modifier = Modifier.height(24.dp))

        Button(
            onClick = {
                if (pairingToken.length >= 4) {
                    isEnrolling = true
                    // Simulate pairing confirmation with public key registration
                    onPairingSuccess()
                } else {
                    errorMessage = "Please enter a valid pairing code"
                }
            },
            enabled = !isEnrolling && pairingToken.isNotEmpty(),
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
