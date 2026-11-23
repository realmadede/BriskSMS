package tz.co.brisksms.ui.components

import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.State
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalDensity
import tz.co.brisksms.ui.theme.BriskShapes
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.abs
import tz.co.brisksms.ui.theme.BriskColors

/** Light tick used when a glass control changes selection. */
@Composable
fun rememberSelectionHaptic(): () -> Unit {
    val haptics = LocalHapticFeedback.current
    return { haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove) }
}

/** Translucent glass fill shared by the top bar, the tab bar and the sheet. */
@Composable
fun glassFill(alpha: Float = 0.92f): Color =
    if (isSystemInDarkTheme()) Color(0xFF1E1E22).copy(alpha = alpha) else Color.White.copy(alpha = alpha)

/**
 * The glass body: lit from above and a little denser toward the lower edge. Gradients and transforms only, so it
 * looks the same on every Android version (real backdrop blur needs API 31, the app supports API 26).
 */
@Composable
fun glassBrush(alpha: Float = 0.92f): Brush {
    val dark = isSystemInDarkTheme()
    val base = glassFill(alpha)
    val top = if (dark) lerp(base, Color.White, 0.07f) else base
    val bottom = if (dark) lerp(base, Color.Black, 0.18f) else lerp(base, BriskColors.canvasBase().copy(alpha = alpha), 0.4f)
    return Brush.verticalGradient(listOf(top, bottom))
}

/** A raised glass capsule: lit gradient, specular rim and a soft shadow so it reads as lying on top of its bar. */
@Composable
fun GlassLens(modifier: Modifier = Modifier) {
    val dark = isSystemInDarkTheme()
    val shape = RoundedCornerShape(50)
    val top = if (dark) Color(0xFF36363D) else Color.White
    val bottom = if (dark) Color(0xFF2A2A2F) else lerp(Color.White, BriskColors.canvasBase(), 0.3f)
    val rimTop = if (dark) Color(0x40FFFFFF) else Color.White
    Box(
        modifier = modifier
            .shadow(3.dp, shape, ambientColor = Color(0x1F2D281E), spotColor = Color(0x262D281E))
            .background(Brush.verticalGradient(listOf(top, bottom)), shape)
            .border(BorderStroke(0.5.dp, Brush.verticalGradient(listOf(rimTop, BriskColors.borderHairline()))), shape)
    )
}

/** 1 at rest and slightly wider while the lens travels, like a drop of glass being pulled along. */
@Composable
fun rememberLensStretch(position: Dp, target: Dp): State<Float> =
    animateFloatAsState(
        targetValue = if (abs((position - target).value) > 2f) 1.08f else 1f,
        animationSpec = spring(dampingRatio = 0.6f, stiffness = Spring.StiffnessMedium),
        label = "lensStretch"
    )

/** Large page title that sits at the top of a scrolling list and fades out as the page scrolls. */
@Composable
fun LargeTitle(
    title: String,
    subtitle: String,
    modifier: Modifier = Modifier,
    trailing: (@Composable () -> Unit)? = null
) {
    Row(modifier = modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = title,
                style = MaterialTheme.typography.headlineLarge.copy(fontSize = 34.sp, lineHeight = 40.sp),
                color = BriskColors.textPrimary()
            )
            Spacer(modifier = Modifier.height(4.dp))
            Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = BriskColors.textSecondary())
        }
        if (trailing != null) {
            Spacer(modifier = Modifier.width(12.dp))
            Box(modifier = Modifier.padding(top = 12.dp)) { trailing() }
        }
    }
}

/** Compact glass bar that fades in once the large title has scrolled away. [progress] runs from 0 to 1. */
@Composable
fun GlassTopBar(title: String, progress: Float, modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .fillMaxWidth()
            .height(48.dp)
            .alpha(progress)
            .background(glassFill(alpha = 1f))
    ) {
        Text(
            text = title,
            style = MaterialTheme.typography.titleSmall,
            color = BriskColors.textPrimary(),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.align(Alignment.Center)
        )
        Box(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .height(0.5.dp)
                .background(BriskColors.borderHairline())
        )
    }
}

/** Segmented control with a glass lens that slides to the selected option. */
@Composable
fun GlassSegmented(
    options: List<String>,
    selectedIndex: Int,
    onSelect: (Int) -> Unit,
    modifier: Modifier = Modifier
) {
    val dark = isSystemInDarkTheme()
    val shape = RoundedCornerShape(50)
    val track = if (dark) Color(0xFF1E1E22) else Color(0x1F767680).compositeOverCanvas()
    val haptic = rememberSelectionHaptic()

    BoxWithConstraints(
        modifier = modifier
            .fillMaxWidth()
            .height(40.dp)
            .background(track, shape)
            .padding(3.dp)
    ) {
        val slot: Dp = maxWidth / options.size
        val lensX by animateDpAsState(
            targetValue = slot * selectedIndex,
            animationSpec = spring(dampingRatio = 0.85f, stiffness = Spring.StiffnessMedium),
            label = "segmentLens"
        )
        val stretch by rememberLensStretch(lensX, slot * selectedIndex)
        GlassLens(
            Modifier
                .offset(x = lensX)
                .width(slot)
                .fillMaxHeight()
                .graphicsLayer {
                    scaleX = stretch
                    scaleY = 1f + (stretch - 1f) / 2f
                }
        )
        Row(modifier = Modifier.fillMaxWidth().fillMaxHeight()) {
            options.forEachIndexed { index, label ->
                val selected = index == selectedIndex
                Box(
                    modifier = Modifier
                        .width(slot)
                        .fillMaxHeight()
                        .selectable(
                            selected = selected,
                            role = Role.Tab,
                            interactionSource = MutableInteractionSource(),
                            indication = null,
                            onClick = {
                                if (!selected) haptic()
                                onSelect(index)
                            }
                        ),
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        text = label,
                        style = MaterialTheme.typography.labelMedium,
                        color = if (selected) BriskColors.textPrimary() else BriskColors.textSecondary(),
                        maxLines = 1
                    )
                }
            }
        }
    }
}

// The light track is a translucent grey that has to sit on the bone canvas, so flatten it once here
private fun Color.compositeOverCanvas(): Color {
    val bg = BriskColors.CanvasBaseLight
    val a = alpha
    return Color(
        red = red * a + bg.red * (1 - a),
        green = green * a + bg.green * (1 - a),
        blue = blue * a + bg.blue * (1 - a),
        alpha = 1f
    )
}

/**
 * Corner shape for row [index] of [count] inside one grouped inset list: only the outer corners of the
 * group are rounded, so separate rows read as one card.
 */
fun groupedShape(index: Int, count: Int, radius: Dp): RoundedCornerShape = when {
    count <= 1 -> RoundedCornerShape(radius)
    index == 0 -> RoundedCornerShape(topStart = radius, topEnd = radius)
    index == count - 1 -> RoundedCornerShape(bottomStart = radius, bottomEnd = radius)
    else -> RoundedCornerShape(0.dp)
}

@Composable
fun GroupedSectionHeader(text: String, modifier: Modifier = Modifier) {
    Text(
        text = text,
        style = MaterialTheme.typography.labelMedium,
        color = BriskColors.textSecondary(),
        modifier = modifier.padding(start = 16.dp, top = 20.dp, bottom = 8.dp)
    )
}

private val CollapseRange = 56.dp

/** 0 while the large title is fully visible, 1 once it has scrolled away. */
@Composable
fun rememberTitleCollapse(listState: LazyListState): State<Float> {
    val rangePx = with(LocalDensity.current) { CollapseRange.toPx() }
    return remember(listState) {
        derivedStateOf {
            if (listState.firstVisibleItemIndex > 0) 1f
            else (listState.firstVisibleItemScrollOffset / rangePx).coerceIn(0f, 1f)
        }
    }
}

@Composable
fun rememberTitleCollapse(scrollState: ScrollState): State<Float> {
    val rangePx = with(LocalDensity.current) { CollapseRange.toPx() }
    // A page that overflows by less than the range must still finish collapsing at its end.
    return remember(scrollState) {
        derivedStateOf {
            val range = minOf(rangePx, scrollState.maxValue.toFloat()).coerceAtLeast(1f)
            (scrollState.value / range).coerceIn(0f, 1f)
        }
    }
}

/** Fades the large title out as the page collapses. */
fun Modifier.fadeWithCollapse(collapse: State<Float>): Modifier = graphicsLayer { alpha = 1f - collapse.value }

/**
 * A scrolling page with a large title that collapses into a [GlassTopBar]. Pages built from static
 * sections use this; pages with a lazy list build the same pieces by hand.
 */
@Composable
fun CollapsingScreen(
    title: String,
    subtitle: String,
    modifier: Modifier = Modifier,
    trailing: (@Composable () -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit
) {
    val scrollState = rememberScrollState()
    val collapse = rememberTitleCollapse(scrollState)
    Box(modifier = modifier.fillMaxSize().background(BriskColors.canvasBase())) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(scrollState)
                .padding(
                    start = ScreenPadding,
                    end = ScreenPadding,
                    bottom = 24.dp + LocalBottomBarInset.current
                )
        ) {
            LargeTitle(
                title = title,
                subtitle = subtitle,
                trailing = trailing,
                modifier = Modifier.padding(top = 24.dp, bottom = 16.dp).fadeWithCollapse(collapse)
            )
            content()
        }
        GlassTopBar(title = title, progress = collapse.value, modifier = Modifier.align(Alignment.TopCenter))
    }
}

/** Bottom sheet with a heading, a status, the message body and a list of label and value details. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DetailSheet(
    title: String,
    status: @Composable () -> Unit,
    body: String,
    details: List<Pair<String, String>>,
    onDismiss: () -> Unit
) {
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = glassFill(alpha = 1f),
        shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp),
        tonalElevation = 0.dp
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = ScreenPadding, end = ScreenPadding, bottom = 24.dp)
                .navigationBarsPadding()
        ) {
            Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = title,
                    style = MaterialTheme.typography.titleLarge,
                    color = BriskColors.textPrimary(),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f)
                )
                Spacer(modifier = Modifier.width(12.dp))
                status()
            }
            Spacer(modifier = Modifier.height(16.dp))
            Surface(shape = BriskShapes.medium, color = BriskColors.canvasBase(), modifier = Modifier.fillMaxWidth()) {
                Text(
                    text = body,
                    style = MaterialTheme.typography.bodyMedium,
                    color = BriskColors.textPrimary(),
                    modifier = Modifier.padding(16.dp)
                )
            }
            Spacer(modifier = Modifier.height(8.dp))
            details.forEachIndexed { index, (label, value) ->
                if (index > 0) HairlineDivider()
                KeyValueRow(label, value)
            }
        }
    }
}

/** Day header for grouped lists: Today, Yesterday or a dated label. */
fun dayLabel(millis: Long): String {
    val zone = ZoneId.systemDefault()
    val day = Instant.ofEpochMilli(millis).atZone(zone).toLocalDate()
    val today = LocalDate.now(zone)
    return when (day) {
        today -> "Today"
        today.minusDays(1) -> "Yesterday"
        else -> day.format(DateTimeFormatter.ofPattern("d MMM yyyy", Locale.getDefault()))
    }
}
