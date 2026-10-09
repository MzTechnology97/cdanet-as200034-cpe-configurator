package it.cdanet.cpeconfigurator.ui

import android.app.Activity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** CDA Net brand orange: the seed of the whole Material 3 palette. */
val CdaOrange = Color(0xFFF15A2C)

/** Status colors (ok / attention / error), each with its tonal container, for light and dark. */
@Immutable
data class StatusColors(
    val good: Color,
    val goodContainer: Color,
    val warn: Color,
    val warnContainer: Color,
    val bad: Color,
    val badContainer: Color,
)

private val LightStatus = StatusColors(
    good = Color(0xFF1A7F4B), goodContainer = Color(0xFFD6F2E2),
    warn = Color(0xFF8F5B00), warnContainer = Color(0xFFFFE8C2),
    bad = Color(0xFFB42318), badContainer = Color(0xFFFFDAD5),
)
private val DarkStatus = StatusColors(
    good = Color(0xFF6DD9A0), goodContainer = Color(0xFF0F3D26),
    warn = Color(0xFFF2C064), warnContainer = Color(0xFF473100),
    bad = Color(0xFFFFB4A9), badContainer = Color(0xFF5C120C),
)

val LocalStatusColors = staticCompositionLocalOf { LightStatus }

// Status colors used all over the app: they follow the light or dark theme.
val GoodGreen: Color @Composable @ReadOnlyComposable get() = LocalStatusColors.current.good
val WarnAmber: Color @Composable @ReadOnlyComposable get() = LocalStatusColors.current.warn
val BadRed: Color @Composable @ReadOnlyComposable get() = LocalStatusColors.current.bad

/**
 * Accent per area of the app (home tiles, section headers): a strong tone for the icon and a soft
 * container behind it. Light and dark variants keep the contrast.
 */
@Immutable
data class Accent(val content: Color, val container: Color)

enum class Area(private val light: Accent, private val dark: Accent) {
    Work(Accent(Color(0xFFB83A14), Color(0xFFFFDBCF)), Accent(Color(0xFFFFB59C), Color(0xFF5C2210))),
    Network(Accent(Color(0xFF1F5FBF), Color(0xFFD8E2FF)), Accent(Color(0xFFADC6FF), Color(0xFF0E3470))),
    Field(Accent(Color(0xFF006B5F), Color(0xFFB8F0E3)), Accent(Color(0xFF7DD8C6), Color(0xFF00433B))),
    Tools(Accent(Color(0xFF6A4FA3), Color(0xFFEADDFF)), Accent(Color(0xFFD3BBFF), Color(0xFF452B78))),
    Help(Accent(Color(0xFF52606D), Color(0xFFDDE3EA)), Accent(Color(0xFFBEC8D2), Color(0xFF34404B)));

    val accent: Accent @Composable @ReadOnlyComposable get() = if (LocalDarkTheme.current) dark else light
}

val LocalDarkTheme = staticCompositionLocalOf { false }

private val Light = lightColorScheme(
    primary = Color(0xFFC2410F),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFFFDBCF),
    onPrimaryContainer = Color(0xFF3A0B00),
    secondary = Color(0xFF77574C),
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFFFDBCF),
    onSecondaryContainer = Color(0xFF2C160D),
    tertiary = Color(0xFF00696E),
    onTertiary = Color.White,
    tertiaryContainer = Color(0xFF9CF0F5),
    onTertiaryContainer = Color(0xFF002022),
    error = Color(0xFFB42318),
    errorContainer = Color(0xFFFFDAD5),
    onErrorContainer = Color(0xFF410001),
    background = Color(0xFFFBF8F6),
    onBackground = Color(0xFF201A18),
    surface = Color(0xFFFBF8F6),
    onSurface = Color(0xFF201A18),
    surfaceVariant = Color(0xFFF2DFD8),
    onSurfaceVariant = Color(0xFF53433E),
    surfaceContainerLowest = Color.White,
    surfaceContainerLow = Color(0xFFFFFFFF),
    surfaceContainer = Color(0xFFF6F0EE),
    surfaceContainerHigh = Color(0xFFF0EAE7),
    surfaceContainerHighest = Color(0xFFEAE4E1),
    surfaceBright = Color(0xFFFBF8F6),
    surfaceDim = Color(0xFFE2DAD7),
    outline = Color(0xFF85736D),
    outlineVariant = Color(0xFFE2D4CF),
    inverseSurface = Color(0xFF362F2C),
    inverseOnSurface = Color(0xFFFBEEEA),
    inversePrimary = Color(0xFFFFB59C),
)

private val Dark = darkColorScheme(
    primary = Color(0xFFFFB59C),
    onPrimary = Color(0xFF5C1900),
    primaryContainer = Color(0xFF822A06),
    onPrimaryContainer = Color(0xFFFFDBCF),
    secondary = Color(0xFFE7BDB0),
    onSecondary = Color(0xFF442A21),
    secondaryContainer = Color(0xFF5D4036),
    onSecondaryContainer = Color(0xFFFFDBCF),
    tertiary = Color(0xFF80D4D9),
    onTertiary = Color(0xFF00363A),
    tertiaryContainer = Color(0xFF004F53),
    onTertiaryContainer = Color(0xFF9CF0F5),
    error = Color(0xFFFFB4A9),
    errorContainer = Color(0xFF8C1D12),
    onErrorContainer = Color(0xFFFFDAD5),
    background = Color(0xFF141110),
    onBackground = Color(0xFFEDE0DC),
    surface = Color(0xFF141110),
    onSurface = Color(0xFFEDE0DC),
    surfaceVariant = Color(0xFF53433E),
    onSurfaceVariant = Color(0xFFD8C2BB),
    surfaceContainerLowest = Color(0xFF0F0C0B),
    surfaceContainerLow = Color(0xFF1D1917),
    surfaceContainer = Color(0xFF211D1B),
    surfaceContainerHigh = Color(0xFF2C2725),
    surfaceContainerHighest = Color(0xFF37322F),
    surfaceBright = Color(0xFF3B3735),
    surfaceDim = Color(0xFF141110),
    outline = Color(0xFFA08D87),
    outlineVariant = Color(0xFF53433E),
    inverseSurface = Color(0xFFEDE0DC),
    inverseOnSurface = Color(0xFF362F2C),
    inversePrimary = Color(0xFFA63B10),
)

private val CdaShapes = Shapes(
    extraSmall = RoundedCornerShape(8.dp),
    small = RoundedCornerShape(12.dp),
    medium = RoundedCornerShape(16.dp),
    large = RoundedCornerShape(24.dp),
    extraLarge = RoundedCornerShape(32.dp),
)

private val CdaTypography = Typography().run {
    copy(
        headlineSmall = headlineSmall.copy(fontWeight = FontWeight.SemiBold),
        titleLarge = titleLarge.copy(fontWeight = FontWeight.SemiBold, letterSpacing = 0.sp),
        titleMedium = titleMedium.copy(fontWeight = FontWeight.SemiBold),
        titleSmall = titleSmall.copy(fontWeight = FontWeight.SemiBold),
        labelLarge = labelLarge.copy(fontWeight = FontWeight.SemiBold),
    )
}

@Composable
fun CdaTheme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    // The activity handles uiMode changes itself (no restart): keep the status and navigation bar
    // icons readable when the phone switches between light and dark while the app is open.
    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            (view.context as? Activity)?.window?.let { w ->
                WindowCompat.getInsetsController(w, view).apply {
                    isAppearanceLightStatusBars = !dark
                    isAppearanceLightNavigationBars = !dark
                }
            }
        }
    }
    CompositionLocalProvider(LocalDarkTheme provides dark, LocalStatusColors provides if (dark) DarkStatus else LightStatus) {
        MaterialTheme(colorScheme = if (dark) Dark else Light, shapes = CdaShapes, typography = CdaTypography, content = content)
    }
}

/** Status palette of the current theme (containers for chips and banners). */
val StatusPalette: StatusColors @Composable @ReadOnlyComposable get() = LocalStatusColors.current
