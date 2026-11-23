package tz.co.brisksms.ui.components

import androidx.annotation.DrawableRes
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import tz.co.brisksms.R
import tz.co.brisksms.ui.theme.BriskColors
import tz.co.brisksms.ui.theme.BriskMonoStyle
import tz.co.brisksms.ui.theme.BriskShapes

/** Horizontal page padding shared by every screen. */
val ScreenPadding = 20.dp

@Composable
fun BriskMark(size: Dp = 32.dp, modifier: Modifier = Modifier) {
    Image(
        painter = painterResource(R.drawable.ic_brisk_mark),
        contentDescription = "BriskSMS",
        modifier = modifier.size(size)
    )
}

@Composable
fun ScreenHeader(
    title: String,
    subtitle: String,
    modifier: Modifier = Modifier,
    trailing: (@Composable () -> Unit)? = null
) {
    Row(modifier = modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
        Column(modifier = Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.headlineSmall, color = BriskColors.textPrimary())
            Spacer(modifier = Modifier.height(4.dp))
            Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = BriskColors.textSecondary())
        }
        if (trailing != null) {
            Spacer(modifier = Modifier.width(12.dp))
            Box(modifier = Modifier.padding(top = 8.dp)) { trailing() }
        }
    }
}

@Composable
fun SectionLabel(text: String, modifier: Modifier = Modifier) {
    Text(
        text = text,
        style = MaterialTheme.typography.labelMedium,
        color = BriskColors.textSecondary(),
        modifier = modifier.padding(bottom = 8.dp)
    )
}

@Composable
fun BriskCard(
    modifier: Modifier = Modifier,
    onClick: (() -> Unit)? = null,
    contentPadding: PaddingValues = PaddingValues(16.dp),
    content: @Composable ColumnScope.() -> Unit
) {
    val border = BorderStroke(Dp.Hairline, BriskColors.borderHairline())
    if (onClick != null) {
        Surface(
            onClick = onClick,
            shape = BriskShapes.large,
            color = BriskColors.cardContainer(),
            border = border,
            modifier = modifier
        ) { Column(modifier = Modifier.padding(contentPadding), content = content) }
    } else {
        Surface(
            shape = BriskShapes.large,
            color = BriskColors.cardContainer(),
            border = border,
            modifier = modifier
        ) { Column(modifier = Modifier.padding(contentPadding), content = content) }
    }
}

enum class StatusKind { Positive, Review, Negative, Neutral, Accent }

/** Status is always an icon (or dot) plus text, never color alone (design system 6.2). */
@Composable
fun StatusTag(kind: StatusKind, text: String, modifier: Modifier = Modifier) {
    Row(
        modifier = modifier,
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        when (kind) {
            StatusKind.Positive -> StatusIcon(R.drawable.ic_circle_check, BriskColors.StatusVerified)
            StatusKind.Review -> StatusIcon(R.drawable.ic_triangle_alert, BriskColors.StatusReview)
            StatusKind.Negative -> StatusIcon(R.drawable.ic_circle_x, BriskColors.StatusRejected)
            StatusKind.Neutral -> StatusDot(BriskColors.textTertiary())
            StatusKind.Accent -> StatusDot(BriskColors.accentPill())
        }
        Text(text, style = MaterialTheme.typography.labelMedium, color = BriskColors.textPrimary(), maxLines = 1)
    }
}

@Composable
private fun StatusIcon(@DrawableRes icon: Int, tint: Color) {
    Icon(painterResource(icon), contentDescription = null, tint = tint, modifier = Modifier.size(16.dp))
}

@Composable
private fun StatusDot(color: Color) {
    Box(modifier = Modifier.size(16.dp), contentAlignment = Alignment.Center) {
        Box(modifier = Modifier.size(8.dp).background(color, CircleShape))
    }
}

@Composable
fun KeyValueRow(
    label: String,
    value: String,
    modifier: Modifier = Modifier,
    mono: Boolean = false,
    valueColor: Color = BriskColors.textPrimary()
) {
    Row(
        modifier = modifier.fillMaxWidth().heightIn(min = 44.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.bodyMedium,
            color = BriskColors.textSecondary(),
            modifier = Modifier.padding(end = 16.dp)
        )
        Spacer(modifier = Modifier.weight(1f))
        Text(
            text = value,
            style = if (mono) BriskMonoStyle else MaterialTheme.typography.bodyMedium.copy(fontFeatureSettings = "tnum"),
            color = valueColor,
            textAlign = TextAlign.End,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
    }
}

@Composable
fun HairlineDivider(modifier: Modifier = Modifier) {
    HorizontalDivider(modifier = modifier, thickness = Dp.Hairline, color = BriskColors.borderHairline())
}

@Composable
fun PrimaryPillButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    loading: Boolean = false,
    @DrawableRes icon: Int? = null
) {
    val fill = BriskColors.accentPill()
    Button(
        onClick = onClick,
        enabled = enabled && !loading,
        shape = BriskShapes.extraLarge,
        colors = ButtonDefaults.buttonColors(
            containerColor = fill,
            contentColor = BriskColors.ContrastPill,
            disabledContainerColor = fill.copy(alpha = 0.5f),
            disabledContentColor = BriskColors.ContrastPill.copy(alpha = 0.6f)
        ),
        contentPadding = PaddingValues(horizontal = 20.dp),
        modifier = modifier.fillMaxWidth().height(48.dp)
    ) {
        if (loading) {
            CircularProgressIndicator(color = BriskColors.ContrastPill, strokeWidth = 2.dp, modifier = Modifier.size(20.dp))
        } else {
            if (icon != null) {
                Icon(painterResource(icon), contentDescription = null, modifier = Modifier.size(20.dp))
                Spacer(modifier = Modifier.width(8.dp))
            }
            Text(text, style = MaterialTheme.typography.labelLarge)
        }
    }
}

@Composable
fun SecondaryPillButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    loading: Boolean = false,
    contentColor: Color = BriskColors.textPrimary(),
    @DrawableRes icon: Int? = null
) {
    OutlinedButton(
        onClick = onClick,
        enabled = enabled && !loading,
        shape = BriskShapes.extraLarge,
        border = BorderStroke(Dp.Hairline, BriskColors.borderHairline()),
        colors = ButtonDefaults.outlinedButtonColors(
            containerColor = BriskColors.cardContainer(),
            contentColor = contentColor,
            disabledContainerColor = BriskColors.cardContainer(),
            disabledContentColor = BriskColors.textTertiary()
        ),
        contentPadding = PaddingValues(horizontal = 20.dp),
        modifier = modifier.fillMaxWidth().height(48.dp)
    ) {
        if (loading) {
            CircularProgressIndicator(color = contentColor, strokeWidth = 2.dp, modifier = Modifier.size(20.dp))
        } else {
            if (icon != null) {
                Icon(painterResource(icon), contentDescription = null, modifier = Modifier.size(20.dp))
                Spacer(modifier = Modifier.width(8.dp))
            }
            Text(text, style = MaterialTheme.typography.labelLarge)
        }
    }
}

/** Tappable list row inside a card: leading icon, label, trailing affordance. */
@Composable
fun ActionRow(
    @DrawableRes icon: Int,
    text: String,
    onClick: () -> Unit,
    @DrawableRes trailingIcon: Int = R.drawable.ic_chevron_right,
    status: (@Composable () -> Unit)? = null
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .heightIn(min = 52.dp)
            .padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box(
            modifier = Modifier.size(30.dp).background(BriskColors.canvasBase(), BriskShapes.small),
            contentAlignment = Alignment.Center
        ) {
            Icon(painterResource(icon), contentDescription = null, tint = BriskColors.textSecondary(), modifier = Modifier.size(18.dp))
        }
        Spacer(modifier = Modifier.width(12.dp))
        Text(text, style = MaterialTheme.typography.bodyLarge, color = BriskColors.textPrimary(), modifier = Modifier.weight(1f))
        if (status != null) {
            status()
            Spacer(modifier = Modifier.width(8.dp))
        }
        Icon(painterResource(trailingIcon), contentDescription = null, tint = BriskColors.textTertiary(), modifier = Modifier.size(20.dp))
    }
}

@Composable
fun Figure(label: String, value: String, modifier: Modifier = Modifier, valueColor: Color = BriskColors.textPrimary()) {
    Column(modifier = modifier) {
        Text(label, style = MaterialTheme.typography.bodySmall, color = BriskColors.textSecondary())
        Spacer(modifier = Modifier.height(4.dp))
        Text(value, style = MaterialTheme.typography.displaySmall, color = valueColor)
    }
}

/**
 * Signature detail: the receipt tear line. Edge notches take the canvas color so the card reads as a
 * perforated slip. Use only on the pairing slip and the Overview "Today" receipt.
 */
@Composable
fun PerforatedDivider(modifier: Modifier = Modifier) {
    val notch = BriskColors.canvasBase()
    val dash = BriskColors.textTertiary().copy(alpha = 0.5f)
    Canvas(modifier = modifier.fillMaxWidth().height(16.dp)) {
        val r = 8.dp.toPx()
        val cy = size.height / 2
        drawCircle(notch, radius = r, center = Offset(0f, cy))
        drawCircle(notch, radius = r, center = Offset(size.width, cy))
        val inset = r + 8.dp.toPx()
        drawLine(
            color = dash,
            start = Offset(inset, cy),
            end = Offset(size.width - inset, cy),
            strokeWidth = 1.dp.toPx(),
            pathEffect = PathEffect.dashPathEffect(floatArrayOf(4.dp.toPx(), 4.dp.toPx()))
        )
    }
}
