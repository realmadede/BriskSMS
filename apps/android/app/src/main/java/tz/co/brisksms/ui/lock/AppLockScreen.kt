package tz.co.brisksms.ui.lock

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import tz.co.brisksms.R
import tz.co.brisksms.ui.components.BriskMark
import tz.co.brisksms.ui.components.PrimaryPillButton
import tz.co.brisksms.ui.components.ScreenPadding
import tz.co.brisksms.ui.theme.BriskColors

/** Covers the whole app until the owner passes the phone's own screen lock. */
@Composable
fun AppLockScreen(onUnlock: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(BriskColors.canvasBase())
            .pointerInput(Unit) { detectTapGestures { } }
            .padding(horizontal = ScreenPadding),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        BriskMark(size = 48.dp)
        Spacer(modifier = Modifier.height(24.dp))
        Text("BriskSMS is locked", style = MaterialTheme.typography.headlineSmall, color = BriskColors.textPrimary())
        Spacer(modifier = Modifier.height(8.dp))
        Text(
            "Use your phone's screen lock to continue. Payments and messages keep running in the background.",
            style = MaterialTheme.typography.bodyMedium,
            color = BriskColors.textSecondary(),
            textAlign = TextAlign.Center
        )
        Spacer(modifier = Modifier.height(32.dp))
        PrimaryPillButton(text = "Unlock", icon = R.drawable.ic_lock, onClick = onUnlock)
    }
}
