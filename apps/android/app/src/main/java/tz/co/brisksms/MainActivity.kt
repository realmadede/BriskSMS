package tz.co.brisksms

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
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
import tz.co.brisksms.core.storage.KeystoreSecureStorage
import tz.co.brisksms.ui.health.DeviceHealthScreen
import tz.co.brisksms.ui.messaging.BulkMessagingScreen
import tz.co.brisksms.ui.overview.OverviewScreen
import tz.co.brisksms.ui.pairing.PairingScreen
import tz.co.brisksms.ui.payment.PaymentIntelligenceScreen
import tz.co.brisksms.ui.settings.SettingsScreen
import tz.co.brisksms.ui.theme.BriskColors
import tz.co.brisksms.ui.theme.BriskShapes

enum class NavigationTab(val label: String, val badge: String) {
    OVERVIEW("Overview", "OV"),
    PAYMENT("Payment", "PAY"),
    MESSAGING("SMSGate", "SMS"),
    HEALTH("Health", "HLT"),
    SETTINGS("Settings", "CFG")
}

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        setContent {
            val secureStorage = remember { KeystoreSecureStorage(applicationContext) }
            var isPaired by remember { mutableStateOf(secureStorage.isPaired) }
            var currentTab by remember { mutableStateOf(NavigationTab.OVERVIEW) }

            if (!isPaired) {
                PairingScreen(
                    onPairingSuccess = {
                        isPaired = true
                        currentTab = NavigationTab.OVERVIEW
                    }
                )
            } else {
                Scaffold(
                    bottomBar = {
                        NavigationBar(
                            containerColor = BriskColors.SurfaceSolidLight,
                            contentColor = BriskColors.TextPrimaryLight,
                            tonalElevation = 6.dp
                        ) {
                            NavigationTab.values().forEach { tab ->
                                val selected = currentTab == tab
                                NavigationBarItem(
                                    selected = selected,
                                    onClick = { currentTab = tab },
                                    icon = {
                                        Surface(
                                            shape = BriskShapes.extraLarge,
                                            color = if (selected) BriskColors.ContrastPill else Color.Transparent,
                                            modifier = Modifier.size(width = 36.dp, height = 24.dp)
                                        ) {
                                            Box(contentAlignment = Alignment.Center) {
                                                Text(
                                                    text = tab.badge,
                                                    fontSize = 10.sp,
                                                    fontWeight = FontWeight.Bold,
                                                    color = if (selected) Color.White else BriskColors.TextTertiaryLight
                                                )
                                            }
                                        }
                                    },
                                    label = {
                                        Text(
                                            text = tab.label,
                                            fontSize = 11.sp,
                                            fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal,
                                            color = if (selected) BriskColors.TextPrimaryLight else BriskColors.TextSecondaryLight
                                        )
                                    },
                                    colors = NavigationBarItemDefaults.colors(
                                        indicatorColor = Color.Transparent
                                    )
                                )
                            }
                        }
                    }
                ) { innerPadding ->
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(innerPadding)
                    ) {
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
                }
            }
        }
    }
}
