package tz.co.brisksms.ui.settings

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import tz.co.brisksms.BuildConfig
import tz.co.brisksms.R
import tz.co.brisksms.ui.components.*
import tz.co.brisksms.ui.theme.BriskColors
import tz.co.brisksms.update.UpdateEngine
import tz.co.brisksms.update.UpdateState

/** Direct build: checks, downloads and installs updates itself. Play build: Google Play does the updating. */
@Composable
fun AppUpdateSection() {
    val context = LocalContext.current
    SectionLabel("App updates")
    if (BuildConfig.SELF_UPDATE) SelfUpdateCard(context) else PlayUpdateCard(context)
}

@Composable
private fun PlayUpdateCard(context: Context) {
    BriskCard(modifier = Modifier.fillMaxWidth(), contentPadding = PaddingValues(0.dp)) {
        ActionRow(
            icon = R.drawable.ic_refresh_cw,
            text = "Check for updates in Google Play",
            trailingIcon = R.drawable.ic_external_link,
            onClick = {
                val id = context.packageName
                val market = Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=$id"))
                val web = Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=$id"))
                runCatching { context.startActivity(market) }.recoverCatching { context.startActivity(web) }
            }
        )
    }
}

@Composable
private fun SelfUpdateCard(context: Context) {
    val engine = remember { UpdateEngine.get(context) }
    val state by engine.state.collectAsState()

    BriskCard(modifier = Modifier.fillMaxWidth()) {
        when (val s = state) {
            is UpdateState.Idle -> StateText("Version ${BuildConfig.VERSION_NAME}", "Check whether a newer version of BriskSMS is available.")
            is UpdateState.Checking -> StateText("Checking for updates", "Contacting the BriskSMS update server.")
            is UpdateState.UpToDate -> StateText("You are up to date", "Version ${BuildConfig.VERSION_NAME} is the latest.")
            is UpdateState.Available -> {
                StateText("Version ${s.release.versionName} is available", s.release.notes.ifBlank { null })
                if (s.release.required) {
                    Spacer(modifier = Modifier.height(8.dp))
                    StatusTag(StatusKind.Review, "Required update")
                }
            }
            is UpdateState.Downloading -> {
                StateText("Downloading version ${s.release.versionName}", "${(s.progress * 100).toInt()}% of the file is on this phone.")
                Spacer(modifier = Modifier.height(12.dp))
                LinearProgressIndicator(
                    progress = { s.progress },
                    modifier = Modifier.fillMaxWidth(),
                    color = BriskColors.accentPill(),
                    trackColor = BriskColors.borderHairline()
                )
            }
            is UpdateState.Ready -> StateText(
                "Version ${s.release.versionName} is ready to install",
                "The file is verified. Android asks you to confirm. If it asks to allow installs from BriskSMS, allow it, return here and tap Install again."
            )
            is UpdateState.Failed -> StateText("Update failed", s.message, isError = true)
        }
    }

    Spacer(modifier = Modifier.height(12.dp))

    when (val s = state) {
        is UpdateState.Available -> PrimaryPillButton("Download and install", onClick = { engine.download() }, icon = R.drawable.ic_refresh_cw)
        is UpdateState.Failed ->
            if (s.release != null) PrimaryPillButton("Try the download again", onClick = { engine.download() }, icon = R.drawable.ic_refresh_cw)
            else CheckButton(loading = false, onClick = { engine.check() })
        is UpdateState.Downloading -> PrimaryPillButton("Downloading", onClick = {}, loading = true)
        is UpdateState.Ready -> PrimaryPillButton("Install", onClick = { engine.install() }, icon = R.drawable.ic_circle_check)
        else -> CheckButton(loading = s is UpdateState.Checking, onClick = { engine.check() })
    }
}

@Composable
private fun CheckButton(loading: Boolean, onClick: () -> Unit) {
    SecondaryPillButton("Check for updates", onClick = onClick, loading = loading, icon = R.drawable.ic_refresh_cw)
}

@Composable
private fun StateText(title: String, detail: String?, isError: Boolean = false) {
    Text(title, style = MaterialTheme.typography.titleSmall, color = BriskColors.textPrimary())
    if (detail != null) {
        Spacer(modifier = Modifier.height(4.dp))
        Text(
            detail,
            style = MaterialTheme.typography.bodySmall,
            color = if (isError) BriskColors.negativeInk() else BriskColors.textSecondary()
        )
    }
}
