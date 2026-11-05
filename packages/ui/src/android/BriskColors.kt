package tz.co.brisksms.ui.theme

import androidx.compose.ui.graphics.Color

/**
 * BriskSMS Stitch & Liquid Glass Palette for Android Jetpack Compose
 */
object BriskColors {
    // Canvas & Atmospheric Tone (Bone & Sand)
    val CanvasBaseLight = Color(0xFFEAE6DF)
    val CanvasDeepLight = Color(0xFFDCD6CB)
    val CanvasBaseDark = Color(0xFF141416)
    val CanvasDeepDark = Color(0xFF1A1A1E)

    // Glass & Card Surfaces
    val SurfaceGlassLight = Color(0xA6FFFFFF) // 65% White
    val SurfaceGlassActiveLight = Color(0xD9ECECF0)
    val SurfaceSolidLight = Color(0xFFF5F3EF)
    val SurfaceGlassDark = Color(0xA6202024)
    val SurfaceSolidDark = Color(0xFF1E1E22)

    // Hairline Stroke
    val BorderHairlineLight = Color(0x14121212) // 8% Obsidian
    val BorderHairlineDark = Color(0x1FFFFFFF)  // 12% White

    // Pill Action Accents
    val AccentPrimary = Color(0xFFC2B28F)       // Warm Ochre / Sand Gold
    val AccentPrimaryHover = Color(0xFFB2A27E)
    val ContrastPill = Color(0xFF121212)        // Deep Obsidian

    // Typography
    val TextPrimaryLight = Color(0xFF121212)    // 12.4:1 contrast (WCAG AAA)
    val TextSecondaryLight = Color(0xFF666666)  // 4.8:1 contrast (WCAG AA)
    val TextTertiaryLight = Color(0xFF8E8A82)
    val TextPrimaryDark = Color(0xFFFFFFFF)
    val TextSecondaryDark = Color(0xFFA0A0A8)
    val TextTertiaryDark = Color(0xFF6E6E76)

    // Status Colors (Non-color paired)
    val StatusVerified = Color(0xFF2E7D32)      // M-Pesa / Verified Green
    val StatusReview = Color(0xFFED6C02)        // Review Required Amber
    val StatusRejected = Color(0xFFD32F2F)      // Duplicate / Error Crimson
}

