package tz.co.brisksms.ui.update

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import tz.co.brisksms.BuildConfig
import tz.co.brisksms.ui.components.StatusKind
import tz.co.brisksms.ui.components.StatusTag
import tz.co.brisksms.ui.theme.BriskColors
import tz.co.brisksms.ui.theme.BriskShapes
import tz.co.brisksms.update.AppRelease
import tz.co.brisksms.update.UpdateEngine
import tz.co.brisksms.update.UpdateReminder
import tz.co.brisksms.update.UpdateState

/**
 * Direct build only. Checks quietly whenever the app opens or comes back to the front and, when a newer
 * version exists, opens a window with what is new. "Not now" closes it and it opens again 24 hours later.
 */
@Composable
fun UpdatePromptHost(enabled: Boolean) {
    if (!BuildConfig.SELF_UPDATE) return

    val context = LocalContext.current
    val engine = remember { UpdateEngine.get(context) }
    val reminder = remember { UpdateReminder(context) }
    val state by engine.state.collectAsState()
    var visible by remember { mutableStateOf(false) }
    var resumes by remember { mutableIntStateOf(0) }

    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                engine.autoCheck()
                resumes++
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    val release: AppRelease? = when (val s = state) {
        is UpdateState.Available -> s.release
        is UpdateState.Downloading -> s.release
        is UpdateState.Ready -> s.release
        is UpdateState.Failed -> s.release
        else -> null
    }

    LaunchedEffect(state, resumes, enabled) {
        when {
            release == null -> visible = false
            enabled && state !is UpdateState.Downloading && reminder.isDue(release) -> visible = true
        }
    }

    if (!visible || !enabled || release == null) return

    UpdateDialog(
        state = state,
        release = release,
        onUpdate = {
            when (state) {
                is UpdateState.Ready -> engine.install()
                else -> engine.download()
            }
        },
        onNotNow = {
            reminder.snooze(release)
            visible = false
        }
    )
}

@Composable
private fun UpdateDialog(state: UpdateState, release: AppRelease, onUpdate: () -> Unit, onNotNow: () -> Unit) {
    val canDismiss = !release.required
    AlertDialog(
        onDismissRequest = { if (canDismiss) onNotNow() },
        properties = DialogProperties(dismissOnBackPress = canDismiss, dismissOnClickOutside = canDismiss),
        containerColor = BriskColors.cardContainer(),
        shape = BriskShapes.large,
        title = { Text("BriskSMS ${release.versionName} is available", style = MaterialTheme.typography.titleMedium) },
        text = {
            Column(
                modifier = Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                Text(
                    "You are on version ${BuildConfig.VERSION_NAME}. Update to get the latest fixes and features.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = BriskColors.textSecondary()
                )
                if (release.notes.isNotBlank()) {
                    Text("What is new", style = MaterialTheme.typography.labelMedium, color = BriskColors.textSecondary())
                    Text(release.notes, style = MaterialTheme.typography.bodyMedium, color = BriskColors.textPrimary())
                }
                if (release.required) StatusTag(StatusKind.Review, "Required update")
                when (state) {
                    is UpdateState.Downloading -> {
                        Text(
                            "Downloading, ${(state.progress * 100).toInt()}%",
                            style = MaterialTheme.typography.bodySmall,
                            color = BriskColors.textSecondary()
                        )
                        LinearProgressIndicator(
                            progress = { state.progress },
                            modifier = Modifier.fillMaxWidth(),
                            color = BriskColors.accentPill(),
                            trackColor = BriskColors.borderHairline()
                        )
                    }
                    is UpdateState.Ready -> Text(
                        "The file is verified. Android asks you to confirm. If it asks to allow installs from BriskSMS, allow it, return here and tap Install again.",
                        style = MaterialTheme.typography.bodySmall,
                        color = BriskColors.textSecondary()
                    )
                    is UpdateState.Failed -> Text(
                        state.message,
                        style = MaterialTheme.typography.bodySmall,
                        color = BriskColors.negativeInk()
                    )
                    else -> if (canDismiss) Text(
                        "If you choose Not now, BriskSMS asks again in 24 hours.",
                        style = MaterialTheme.typography.bodySmall,
                        color = BriskColors.textSecondary()
                    )
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onUpdate, enabled = state !is UpdateState.Downloading) {
                Text(
                    when (state) {
                        is UpdateState.Downloading -> "Downloading"
                        is UpdateState.Ready -> "Install"
                        is UpdateState.Failed -> "Try again"
                        else -> "Update now"
                    },
                    color = BriskColors.accentInk()
                )
            }
        },
        dismissButton = if (canDismiss) {
            { TextButton(onClick = onNotNow) { Text("Not now") } }
        } else null
    )
}
