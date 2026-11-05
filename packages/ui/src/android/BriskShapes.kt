package tz.co.brisksms.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Shapes
import androidx.compose.ui.unit.dp

/**
 * BriskSMS Geometric Corner Radii for Jetpack Compose
 */
val BriskShapes = Shapes(
    extraSmall = RoundedCornerShape(4.dp),
    small = RoundedCornerShape(8.dp),
    medium = RoundedCornerShape(10.dp),  // Controls & Inputs
    large = RoundedCornerShape(18.dp),   // Cards & Panels
    extraLarge = RoundedCornerShape(50)  // Pill Buttons & Badges (9999px)
)
