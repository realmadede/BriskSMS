package tz.co.brisksms.ui.dashboard

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import tz.co.brisksms.data.local.OfflineEvidenceEntity
import tz.co.brisksms.ui.theme.BriskColors
import tz.co.brisksms.ui.theme.BriskShapes

@Composable
fun DashboardScreen(
    recentEvidence: List<OfflineEvidenceEntity> = emptyList(),
    pendingCount: Int = 0,
    onOpenNotificationSettings: () -> Unit
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(BriskColors.CanvasBaseLight)
            .padding(20.dp)
    ) {
        // App Header
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = 12.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column {
                Text(
                    text = "BriskSMS Relay",
                    fontSize = 20.sp,
                    fontWeight = FontWeight.Bold,
                    color = BriskColors.TextPrimaryLight
                )
                Text(
                    text = "Android Payment Ingestion Companion",
                    fontSize = 12.sp,
                    color = BriskColors.TextSecondaryLight
                )
            }

            Surface(
                shape = BriskShapes.extraLarge,
                color = BriskColors.StatusVerified.copy(alpha = 0.15f)
            ) {
                Row(
                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp)
                ) {
                    Box(
                        modifier = Modifier
                            .size(6.dp)
                            .background(BriskColors.StatusVerified, CircleShape)
                    )
                    Text(
                        text = "ACTIVE",
                        fontSize = 11.sp,
                        fontWeight = FontWeight.Bold,
                        color = BriskColors.StatusVerified
                    )
                }
            }
        }

        Spacer(modifier = Modifier.height(16.dp))

        // Metrics Card
        Card(
            shape = BriskShapes.large,
            colors = CardDefaults.cardColors(containerColor = BriskColors.SurfaceSolidLight),
            modifier = Modifier.fillMaxWidth()
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(20.dp),
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Column {
                    Text(text = "PENDING UPLOAD", fontSize = 11.sp, fontWeight = FontWeight.Bold, color = BriskColors.TextTertiaryLight)
                    Text(text = "$pendingCount", fontSize = 28.sp, fontWeight = FontWeight.Bold, color = if (pendingCount > 0) BriskColors.StatusReview else BriskColors.TextPrimaryLight)
                }
                Column(horizontalAlignment = Alignment.End) {
                    Text(text = "KEY ENCRYPTION", fontSize = 11.sp, fontWeight = FontWeight.Bold, color = BriskColors.TextTertiaryLight)
                    Text(text = "ECDSA P-256", fontSize = 18.sp, fontWeight = FontWeight.SemiBold, color = BriskColors.StatusVerified)
                }
            }
        }

        Spacer(modifier = Modifier.height(20.dp))

        // Notification Access Check Button
        OutlinedButton(
            onClick = onOpenNotificationSettings,
            shape = BriskShapes.medium,
            modifier = Modifier.fillMaxWidth()
        ) {
            Text(text = "Verify Notification Access Permissions", fontSize = 13.sp)
        }

        Spacer(modifier = Modifier.height(24.dp))

        Text(
            text = "Captured Financial Notifications",
            fontSize = 15.sp,
            fontWeight = FontWeight.Bold,
            color = BriskColors.TextPrimaryLight,
            modifier = Modifier.padding(bottom = 12.dp)
        )

        if (recentEvidence.isEmpty()) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f),
                contentAlignment = Alignment.Center
            ) {
                Text(
                    text = "Listening for incoming payment notifications...",
                    fontSize = 13.sp,
                    color = BriskColors.TextSecondaryLight
                )
            }
        } else {
            LazyColumn(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                items(recentEvidence) { item ->
                    Card(
                        shape = BriskShapes.medium,
                        colors = CardDefaults.cardColors(containerColor = Color.White),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Column(modifier = Modifier.padding(14.dp)) {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween
                            ) {
                                Text(
                                    text = item.senderAddress,
                                    fontWeight = FontWeight.Bold,
                                    fontSize = 13.sp,
                                    color = BriskColors.TextPrimaryLight
                                )
                                Text(
                                    text = if (item.isUploaded) "FORWARDED" else "QUEUED",
                                    fontSize = 11.sp,
                                    fontWeight = FontWeight.Bold,
                                    color = if (item.isUploaded) BriskColors.StatusVerified else BriskColors.StatusReview
                                )
                            }
                            Spacer(modifier = Modifier.height(4.dp))
                            Text(
                                text = item.rawPayload,
                                fontSize = 12.sp,
                                color = BriskColors.TextSecondaryLight,
                                maxLines = 2
                            )
                        }
                    }
                }
            }
        }
    }
}
