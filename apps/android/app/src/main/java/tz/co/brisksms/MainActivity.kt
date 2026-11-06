package tz.co.brisksms

import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.*
import tz.co.brisksms.ui.dashboard.DashboardScreen
import tz.co.brisksms.ui.pairing.PairingScreen

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        setContent {
            var isPaired by remember {
                val prefs = getSharedPreferences("brisksms_config", MODE_PRIVATE)
                mutableStateOf(prefs.getBoolean("is_paired", false))
            }

            if (!isPaired) {
                PairingScreen(
                    onPairingSuccess = {
                        val prefs = getSharedPreferences("brisksms_config", MODE_PRIVATE)
                        prefs.edit().putBoolean("is_paired", true).apply()
                        isPaired = true
                    }
                )
            } else {
                DashboardScreen(
                    onOpenNotificationSettings = {
                        startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
                    }
                )
            }
        }
    }
}
