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
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import tz.co.brisksms.ui.theme.BriskColors

/**
 * Space the floating tab bar takes at the bottom of the screen. Scrolling screens add it to their bottom
 * padding so the last row can be scrolled clear of the bar while the rest of the content passes behind it.
 */
val LocalBottomBarInset = compositionLocalOf { 0.dp }

val GlassTabBarHeight = 64.dp
val GlassTabBarGap = 12.dp
val GlassTabBarSidePadding = 16.dp

data class GlassTab(val label: String, val iconRes: Int)

/**
 * Floating Liquid Glass tab bar: a translucent capsule lit from above, with a specular rim, a neutral diffuse
 * shadow and a glass lens that stretches as it slides to the selected tab. The fill is translucent so content
 * scrolling behind shows through; there is no backdrop blur (it needs API 31, the app supports API 26).
 */
@Composable
fun GlassTabBar(
    tabs: List<GlassTab>,
    selectedIndex: Int,
    onSelect: (Int) -> Unit,
    modifier: Modifier = Modifier
) {
    val dark = isSystemInDarkTheme()
    val barShape = RoundedCornerShape(50)
    val glass = glassBrush()
    val haptic = rememberSelectionHaptic()
    val rimTop = if (dark) Color(0x33FFFFFF) else Color(0xE6FFFFFF)
    val rimBottom = BriskColors.borderHairline()

    val canvas = BriskColors.canvasBase()
    val navBottom = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    Box(modifier = modifier.fillMaxWidth()) {
        // Scroll-edge fade: content dissolves into the canvas before it reaches the bar
        Box(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .height(GlassTabBarHeight + GlassTabBarGap + navBottom + 24.dp)
                .background(
                    Brush.verticalGradient(
                        0f to Color.Transparent,
                        0.4f to canvas.copy(alpha = 0.9f),
                        1f to canvas
                    )
                )
        )
        Box(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .navigationBarsPadding()
                .padding(start = GlassTabBarSidePadding, end = GlassTabBarSidePadding, bottom = GlassTabBarGap)
                .fillMaxWidth()
                .height(GlassTabBarHeight)
                .shadow(
                    elevation = 16.dp,
                    shape = barShape,
                    ambientColor = Color(0x1F2D281E),
                    spotColor = Color(0x2E2D281E)
                )
                .background(glass, barShape)
                .border(rim(rimTop, rimBottom), barShape)
        ) {
            BoxWithConstraints(
                modifier = Modifier
                    .fillMaxWidth()
                    .fillMaxHeight()
                    .padding(4.dp)
            ) {
                val slot: Dp = maxWidth / tabs.size
                val lensX by animateDpAsState(
                    targetValue = slot * selectedIndex,
                    animationSpec = spring(dampingRatio = 0.85f, stiffness = Spring.StiffnessMedium),
                    label = "glassLens"
                )
                val stretch by rememberLensStretch(lensX, slot * selectedIndex)

                // The lens: a raised glass capsule behind the selected tab
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
                    tabs.forEachIndexed { index, tab ->
                        val selected = index == selectedIndex
                        val tint = if (selected) BriskColors.textPrimary() else BriskColors.textSecondary()
                        val iconScale by animateFloatAsState(
                            targetValue = if (selected) 1.08f else 1f,
                            animationSpec = spring(dampingRatio = 0.6f, stiffness = Spring.StiffnessMedium),
                            label = "tabIconScale"
                        )
                        Column(
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
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.Center
                        ) {
                            Icon(
                                painter = painterResource(tab.iconRes),
                                contentDescription = null,
                                tint = tint,
                                modifier = Modifier
                                    .size(22.dp)
                                    .graphicsLayer {
                                        scaleX = iconScale
                                        scaleY = iconScale
                                    }
                            )
                            Text(
                                text = tab.label,
                                style = MaterialTheme.typography.labelSmall,
                                color = tint,
                                maxLines = 1,
                                modifier = Modifier.padding(top = 2.dp)
                            )
                        }
                    }
                }
            }
        }
    }
}

// Specular rim: bright along the top edge, fading to the hairline along the bottom edge
private fun rim(top: Color, bottom: Color) = BorderStroke(0.5.dp, Brush.verticalGradient(listOf(top, bottom)))
