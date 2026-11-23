package tz.co.brisksms.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import tz.co.brisksms.R

/**
 * Plus Jakarta Sans (SIL OFL 1.1), bundled in res/font. See apps/android/THIRD_PARTY_NOTICES.md.
 */
val BriskFontFamily = FontFamily(
    Font(R.font.plus_jakarta_sans_regular, FontWeight.Normal),
    Font(R.font.plus_jakarta_sans_medium, FontWeight.Medium),
    Font(R.font.plus_jakarta_sans_semibold, FontWeight.SemiBold)
)

private fun style(size: Int, line: Int, weight: FontWeight, tabular: Boolean = false) = TextStyle(
    fontFamily = BriskFontFamily,
    fontSize = size.sp,
    lineHeight = line.sp,
    fontWeight = weight,
    letterSpacing = 0.sp,
    fontFeatureSettings = if (tabular) "tnum" else null
)

/** Weights 400 / 500 / 600 only (design system pass 5). Figures use tabular numerals. */
val BriskTypography = Typography(
    displayLarge = style(40, 44, FontWeight.Medium, tabular = true),
    displayMedium = style(36, 40, FontWeight.Medium, tabular = true),
    displaySmall = style(32, 36, FontWeight.Medium, tabular = true),   // Card figures
    headlineLarge = style(28, 36, FontWeight.Medium),
    headlineMedium = style(26, 32, FontWeight.Medium),
    headlineSmall = style(24, 32, FontWeight.Medium),                  // Page titles, dialog titles
    titleLarge = style(20, 28, FontWeight.Medium),
    titleMedium = style(16, 24, FontWeight.SemiBold),                  // Card titles, wordmark
    titleSmall = style(15, 22, FontWeight.SemiBold),                   // List item primary line
    bodyLarge = style(15, 22, FontWeight.Normal),
    bodyMedium = style(14, 20, FontWeight.Normal),
    bodySmall = style(13, 18, FontWeight.Normal),
    labelLarge = style(15, 20, FontWeight.SemiBold),                   // Buttons
    labelMedium = style(13, 16, FontWeight.Medium),                    // Section labels, nav, tags
    labelSmall = style(12, 16, FontWeight.Medium, tabular = true)      // Meta, timestamps
)

/** Monospace for references, IDs and endpoints (design system type-mono). */
val BriskMonoStyle = TextStyle(
    fontFamily = FontFamily.Monospace,
    fontSize = 13.sp,
    lineHeight = 18.sp,
    letterSpacing = 0.sp
)

private val LightScheme = lightColorScheme(
    primary = BriskColors.AccentInkLight,
    onPrimary = Color.White,
    primaryContainer = BriskColors.AccentPrimary,
    onPrimaryContainer = BriskColors.ContrastPill,
    inversePrimary = BriskColors.AccentPrimaryDark,
    secondary = BriskColors.ContrastPill,
    onSecondary = Color.White,
    secondaryContainer = BriskColors.CanvasDeepLight,
    onSecondaryContainer = BriskColors.TextPrimaryLight,
    tertiary = BriskColors.AccentInkLight,
    onTertiary = Color.White,
    tertiaryContainer = BriskColors.CanvasDeepLight,
    onTertiaryContainer = BriskColors.TextPrimaryLight,
    background = BriskColors.CanvasBaseLight,
    onBackground = BriskColors.TextPrimaryLight,
    surface = Color.White,
    onSurface = BriskColors.TextPrimaryLight,
    surfaceVariant = BriskColors.CanvasDeepLight,
    onSurfaceVariant = BriskColors.TextSecondaryLight,
    surfaceTint = Color.Transparent,
    inverseSurface = BriskColors.ContrastPill,
    inverseOnSurface = Color.White,
    error = BriskColors.StatusRejected,
    onError = Color.White,
    errorContainer = BriskColors.SurfaceSolidLight,
    onErrorContainer = BriskColors.StatusRejected,
    outline = BriskColors.TextTertiaryLight,
    outlineVariant = BriskColors.BorderHairlineLight,
    scrim = Color.Black,
    surfaceBright = Color.White,
    surfaceDim = BriskColors.CanvasDeepLight,
    surfaceContainerLowest = Color.White,
    surfaceContainerLow = BriskColors.SurfaceSolidLight,
    surfaceContainer = BriskColors.SurfaceSolidLight,
    surfaceContainerHigh = BriskColors.SurfaceSolidLight,
    surfaceContainerHighest = BriskColors.CanvasBaseLight
)

private val DarkScheme = darkColorScheme(
    primary = BriskColors.AccentPrimaryDark,
    onPrimary = BriskColors.ContrastPill,
    primaryContainer = BriskColors.AccentPrimaryDark,
    onPrimaryContainer = BriskColors.ContrastPill,
    inversePrimary = BriskColors.AccentInkLight,
    secondary = BriskColors.TextPrimaryDark,
    onSecondary = BriskColors.ContrastPill,
    secondaryContainer = BriskColors.SurfaceRaisedDark,
    onSecondaryContainer = BriskColors.TextPrimaryDark,
    tertiary = BriskColors.AccentPrimaryDark,
    onTertiary = BriskColors.ContrastPill,
    tertiaryContainer = BriskColors.SurfaceRaisedDark,
    onTertiaryContainer = BriskColors.TextPrimaryDark,
    background = BriskColors.CanvasBaseDark,
    onBackground = BriskColors.TextPrimaryDark,
    surface = BriskColors.SurfaceSolidDark,
    onSurface = BriskColors.TextPrimaryDark,
    surfaceVariant = BriskColors.SurfaceRaisedDark,
    onSurfaceVariant = BriskColors.TextSecondaryDark,
    surfaceTint = Color.Transparent,
    inverseSurface = BriskColors.TextPrimaryDark,
    inverseOnSurface = BriskColors.ContrastPill,
    error = BriskColors.StatusRejected,
    onError = Color.White,
    errorContainer = BriskColors.SurfaceRaisedDark,
    onErrorContainer = BriskColors.TextPrimaryDark,
    outline = BriskColors.TextTertiaryDark,
    outlineVariant = BriskColors.BorderHairlineDark,
    scrim = Color.Black,
    surfaceBright = BriskColors.SurfaceRaisedDark,
    surfaceDim = BriskColors.CanvasBaseDark,
    surfaceContainerLowest = BriskColors.CanvasBaseDark,
    surfaceContainerLow = BriskColors.CanvasDeepDark,
    surfaceContainer = BriskColors.CanvasDeepDark,
    surfaceContainerHigh = BriskColors.SurfaceSolidDark,
    surfaceContainerHighest = BriskColors.SurfaceRaisedDark
)

@Composable
fun BriskTheme(darkTheme: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkScheme else LightScheme,
        typography = BriskTypography,
        shapes = BriskShapes,
        content = content
    )
}
