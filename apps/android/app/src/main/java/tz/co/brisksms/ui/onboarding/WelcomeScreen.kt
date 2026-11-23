package tz.co.brisksms.ui.onboarding

import android.os.Build
import androidx.activity.compose.BackHandler
import androidx.annotation.DrawableRes
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import tz.co.brisksms.BuildConfig
import tz.co.brisksms.R
import tz.co.brisksms.ui.components.BriskMark
import tz.co.brisksms.ui.components.HairlineDivider
import tz.co.brisksms.ui.components.PrimaryPillButton
import tz.co.brisksms.ui.components.ScreenPadding
import tz.co.brisksms.ui.components.StatusKind
import tz.co.brisksms.ui.components.StatusTag
import tz.co.brisksms.ui.theme.BriskColors
import tz.co.brisksms.ui.theme.BriskMonoStyle
import tz.co.brisksms.ui.theme.BriskShapes
import kotlin.math.abs

private class WelcomePage(val title: String, val body: String, val illustration: @Composable () -> Unit)

private val asksForNotifications = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU

private val welcomePages = listOf(
    WelcomePage(
        title = "Welcome to BriskSMS",
        body = "When a customer pays, the payment text on this phone goes to your BriskSMS account and is matched to the right invoice. Anything unclear is held for your review."
    ) { AlertMatchIllustration() },
    WelcomePage(
        title = "Only payment messages are read",
        body = "Payment texts from supported mobile money and bank senders are kept, encrypted until they upload. Chats, personal SMS and other apps are ignored and never leave this phone."
    ) { AlertFilterIllustration() },
    WelcomePage(
        title = "Bulk SMS from your own SIM",
        body = "If your plan includes messaging, campaigns you queue in the web console go out through this phone's SIM. Payment matching never uses messaging credits."
    ) { SimRelayIllustration() },
    WelcomePage(
        title = "A few permissions first",
        body = (if (asksForNotifications) {
            "Android will ask to let BriskSMS send SMS, manage phone calls and show notifications."
        } else {
            "Android will ask to let BriskSMS send SMS and manage phone calls."
        }) + " The phone permission only reads your SIM details; BriskSMS never makes calls." +
            (if (BuildConfig.SMS_PAYMENT_CAPTURE) " It will also ask, with an explanation, to receive payment texts." else "") +
            " Notification access for payment texts is turned on after pairing, from the Payments tab."
    ) { PermissionsIllustration() }
)

/**
 * First-launch onboarding carousel, shown once before pairing. Illustrations are composed from the
 * app's own surfaces and are illustrative only; the sample amounts and names are not real data.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun WelcomeScreen(onFinish: () -> Unit) {
    val pagerState = rememberPagerState(pageCount = { welcomePages.size })
    val coroutineScope = rememberCoroutineScope()
    val isLastPage = pagerState.currentPage == welcomePages.lastIndex

    fun goTo(page: Int) {
        coroutineScope.launch { pagerState.animateScrollToPage(page, animationSpec = tween(200)) }
    }

    BackHandler(enabled = pagerState.currentPage > 0) { goTo(pagerState.currentPage - 1) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(BriskColors.canvasBase())
            .systemBarsPadding()
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 56.dp)
                .padding(start = ScreenPadding, end = 8.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            BriskMark(size = 28.dp)
            Spacer(modifier = Modifier.width(8.dp))
            Text(
                text = "BriskSMS",
                style = MaterialTheme.typography.titleMedium,
                color = BriskColors.textPrimary(),
                modifier = Modifier.weight(1f)
            )
            if (!isLastPage) {
                TextButton(
                    onClick = onFinish,
                    colors = ButtonDefaults.textButtonColors(contentColor = BriskColors.textSecondary())
                ) {
                    Text("Skip", style = MaterialTheme.typography.labelLarge)
                }
            }
        }

        HorizontalPager(
            state = pagerState,
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
        ) { index ->
            WelcomePageContent(
                page = welcomePages[index],
                pageOffset = { (pagerState.currentPage - index) + pagerState.currentPageOffsetFraction }
            )
        }

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = ScreenPadding, end = ScreenPadding, top = 16.dp, bottom = 24.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            PageIndicator(count = welcomePages.size, current = pagerState.currentPage)
            Spacer(modifier = Modifier.height(24.dp))
            PrimaryPillButton(
                text = if (isLastPage) "Get started" else "Next",
                onClick = { if (isLastPage) onFinish() else goTo(pagerState.currentPage + 1) }
            )
        }
    }
}

@Composable
private fun WelcomePageContent(page: WelcomePage, pageOffset: () -> Float) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = ScreenPadding, vertical = 8.dp)
    ) {
        // Illustration panel. It trails the swipe slightly (parallax) and is hidden from screen readers;
        // the title and body carry the same information.
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 300.dp)
                .background(BriskColors.canvasDeep(), RoundedCornerShape(24.dp))
                .clearAndSetSemantics { },
            contentAlignment = Alignment.Center
        ) {
            Box(
                modifier = Modifier
                    .padding(24.dp)
                    .graphicsLayer {
                        val offset = pageOffset()
                        translationX = offset * size.width * 0.35f
                        alpha = 1f - (abs(offset) * 0.6f).coerceIn(0f, 1f)
                    }
            ) {
                page.illustration()
            }
        }

        Spacer(modifier = Modifier.height(32.dp))

        Text(page.title, style = MaterialTheme.typography.headlineMedium, color = BriskColors.textPrimary())
        Spacer(modifier = Modifier.height(12.dp))
        Text(page.body, style = MaterialTheme.typography.bodyLarge, color = BriskColors.textSecondary())
    }
}

@Composable
private fun PageIndicator(count: Int, current: Int) {
    Row(
        modifier = Modifier.semantics { contentDescription = "Page ${current + 1} of $count" },
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        repeat(count) { i ->
            val selected = i == current
            val width by animateDpAsState(if (selected) 24.dp else 8.dp, tween(200), label = "dotWidth")
            val color by animateColorAsState(
                if (selected) BriskColors.textPrimary() else BriskColors.textTertiary().copy(alpha = 0.5f),
                tween(200),
                label = "dotColor"
            )
            Box(modifier = Modifier.size(width = width, height = 8.dp).background(color, CircleShape))
        }
    }
}

// --- Illustrations ---

@Composable
private fun MiniCard(modifier: Modifier = Modifier, content: @Composable RowScope.() -> Unit) {
    Surface(
        shape = BriskShapes.medium,
        color = BriskColors.cardContainer(),
        border = BorderStroke(Dp.Hairline, BriskColors.borderHairline()),
        modifier = modifier.fillMaxWidth()
    ) {
        Row(modifier = Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically, content = content)
    }
}

@Composable
private fun IconBadge(@DrawableRes icon: Int, tint: Color = BriskColors.textPrimary()) {
    Box(
        modifier = Modifier
            .size(32.dp)
            .background(BriskColors.canvasBase(), CircleShape),
        contentAlignment = Alignment.Center
    ) {
        Icon(painterResource(icon), contentDescription = null, tint = tint, modifier = Modifier.size(16.dp))
    }
}

@Composable
private fun TwoLine(top: String, bottom: String, modifier: Modifier = Modifier) {
    Column(modifier = modifier) {
        Text(top, style = MaterialTheme.typography.labelSmall, color = BriskColors.textSecondary(), maxLines = 1)
        Spacer(modifier = Modifier.height(2.dp))
        Text(bottom, style = MaterialTheme.typography.titleSmall, color = BriskColors.textPrimary(), maxLines = 1)
    }
}

@Composable
private fun FlowArrow() {
    Icon(
        painter = painterResource(R.drawable.ic_chevron_down),
        contentDescription = null,
        tint = BriskColors.textTertiary(),
        modifier = Modifier
            .padding(vertical = 8.dp)
            .size(20.dp)
    )
}

/** Page 1: a payment alert flowing into a matched invoice. */
@Composable
private fun AlertMatchIllustration() {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        MiniCard {
            IconBadge(R.drawable.ic_bell)
            Spacer(modifier = Modifier.width(12.dp))
            TwoLine("M-Pesa", "Payment received", Modifier.weight(1f))
            Text("TZS 50,000", style = MaterialTheme.typography.titleSmall.copy(fontFeatureSettings = "tnum"), color = BriskColors.textPrimary())
        }
        FlowArrow()
        MiniCard {
            IconBadge(R.drawable.ic_file_text)
            Spacer(modifier = Modifier.width(12.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text("INV-0142", style = BriskMonoStyle, color = BriskColors.textSecondary())
                Spacer(modifier = Modifier.height(2.dp))
                Text("TZS 50,000 due", style = MaterialTheme.typography.titleSmall.copy(fontFeatureSettings = "tnum"), color = BriskColors.textPrimary())
            }
            StatusTag(StatusKind.Positive, "Matched")
        }
    }
}

/** Page 2: the payment alert is kept; a chat and a personal SMS are ignored. */
@Composable
private fun AlertFilterIllustration() {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        MiniCard {
            IconBadge(R.drawable.ic_receipt)
            Spacer(modifier = Modifier.width(12.dp))
            TwoLine("Airtel Money", "Payment received", Modifier.weight(1f))
            StatusTag(StatusKind.Positive, "Read")
        }
        MiniCard(modifier = Modifier.alpha(0.55f)) {
            IconBadge(R.drawable.ic_message_square)
            Spacer(modifier = Modifier.width(12.dp))
            TwoLine("Chat", "See you on Friday", Modifier.weight(1f))
            StatusTag(StatusKind.Negative, "Ignored")
        }
        MiniCard(modifier = Modifier.alpha(0.55f)) {
            IconBadge(R.drawable.ic_mail)
            Spacer(modifier = Modifier.width(12.dp))
            TwoLine("SMS", "Personal message", Modifier.weight(1f))
            StatusTag(StatusKind.Negative, "Ignored")
        }
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 8.dp),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Icon(painterResource(R.drawable.ic_lock), contentDescription = null, tint = BriskColors.textSecondary(), modifier = Modifier.size(16.dp))
            Spacer(modifier = Modifier.width(8.dp))
            Text("Kept payment texts are encrypted on this phone", style = MaterialTheme.typography.labelMedium, color = BriskColors.textSecondary())
        }
    }
}

/** Page 3: a campaign from the web console going out through the phone's SIMs. */
@Composable
private fun SimRelayIllustration() {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        MiniCard {
            IconBadge(R.drawable.ic_mail)
            Spacer(modifier = Modifier.width(12.dp))
            TwoLine("Campaign", "Monthly reminder", Modifier.weight(1f))
            Text("240 recipients", style = MaterialTheme.typography.labelSmall, color = BriskColors.textSecondary())
        }
        FlowArrow()
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            SimTile("SIM 1", "Vodacom", Modifier.weight(1f))
            SimTile("SIM 2", "Airtel", Modifier.weight(1f))
        }
    }
}

@Composable
private fun SimTile(slot: String, carrier: String, modifier: Modifier = Modifier) {
    Surface(
        shape = BriskShapes.medium,
        color = BriskColors.cardContainer(),
        border = BorderStroke(Dp.Hairline, BriskColors.borderHairline()),
        modifier = modifier
    ) {
        Column(modifier = Modifier.padding(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(painterResource(R.drawable.ic_smartphone), contentDescription = null, tint = BriskColors.textSecondary(), modifier = Modifier.size(16.dp))
                Spacer(modifier = Modifier.width(8.dp))
                Text(slot, style = MaterialTheme.typography.labelMedium, color = BriskColors.textSecondary())
            }
            Spacer(modifier = Modifier.height(8.dp))
            Text(carrier, style = MaterialTheme.typography.titleSmall, color = BriskColors.textPrimary())
            Spacer(modifier = Modifier.height(8.dp))
            StatusTag(StatusKind.Accent, "Sending")
        }
    }
}

/** Page 4: the permission sheet the operator is about to see. */
@Composable
private fun PermissionsIllustration() {
    Surface(
        shape = BriskShapes.large,
        color = BriskColors.cardContainer(),
        border = BorderStroke(Dp.Hairline, BriskColors.borderHairline()),
        modifier = Modifier.fillMaxWidth()
    ) {
        Column(modifier = Modifier.padding(horizontal = 16.dp)) {
            PermissionRow(R.drawable.ic_message_square, "Send SMS")
            HairlineDivider()
            PermissionRow(R.drawable.ic_smartphone, "Phone, for SIM details")
            if (asksForNotifications) {
                HairlineDivider()
                PermissionRow(R.drawable.ic_bell, "Notifications")
            }
            HairlineDivider()
            PermissionRow(R.drawable.ic_receipt, "Notification access", afterPairing = true)
        }
    }
}

@Composable
private fun PermissionRow(@DrawableRes icon: Int, label: String, afterPairing: Boolean = false) {
    Row(modifier = Modifier.padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        IconBadge(icon)
        Spacer(modifier = Modifier.width(12.dp))
        Text(label, style = MaterialTheme.typography.titleSmall, color = BriskColors.textPrimary(), modifier = Modifier.weight(1f))
        if (afterPairing) {
            Text("After pairing", style = MaterialTheme.typography.labelSmall, color = BriskColors.textTertiary())
        } else {
            // Drawn "on" toggle; decorative, the real prompt comes from Android.
            Box(
                modifier = Modifier
                    .size(width = 36.dp, height = 20.dp)
                    .background(BriskColors.accentPill(), CircleShape)
                    .padding(2.dp),
                contentAlignment = Alignment.CenterEnd
            ) {
                Box(modifier = Modifier.size(16.dp).background(Color.White, CircleShape))
            }
        }
    }
}
