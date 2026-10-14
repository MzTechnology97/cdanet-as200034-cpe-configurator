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

/** CDA Net brand orange (the --brand token of the console). */
val CdaOrange = ConsoleTokens.Light.brand

/** Status colors (ok / attention / error / information), each with its soft background, as the console. */
@Immutable
data class StatusColors(
    val good: Color,
    val goodContainer: Color,
    val warn: Color,
    val warnContainer: Color,
    val bad: Color,
    val badContainer: Color,
    val info: Color,
    val infoContainer: Color,
)

private fun statusOf(t: ConsolePalette) = StatusColors(
    good = t.good, goodContainer = t.goodBg,
    warn = t.warn, warnContainer = t.warnBg,
    bad = t.bad, badContainer = t.badBg,
    info = t.info, infoContainer = t.infoBg,
)
private val LightStatus = statusOf(ConsoleTokens.Light)
private val DarkStatus = statusOf(ConsoleTokens.Dark)

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

/**
 * Material 3 roles from the tokens of the console (ConsoleTokens, generated from tokens.css): the
 * neutral surfaces of the console, its brand orange for the actions and its state colours. The
 * screens keep using the Material roles, so they all follow the console at once.
 */
private fun lightScheme(t: ConsolePalette) = lightColorScheme(
    primary = t.brandInk,
    onPrimary = Color.White,
    primaryContainer = t.brandSoft,
    onPrimaryContainer = t.brandInk,
    // selected chips, the bar at the bottom: the soft brand of the active item in the console
    secondary = t.muted,
    onSecondary = Color.White,
    secondaryContainer = t.brandSoft,
    onSecondaryContainer = t.brandInk,
    tertiary = t.info,
    onTertiary = Color.White,
    tertiaryContainer = t.infoBg,
    onTertiaryContainer = t.info,
    error = t.bad,
    onError = Color.White,
    errorContainer = t.badBg,
    onErrorContainer = t.bad,
    background = t.bg,
    onBackground = t.ink,
    surface = t.bg,
    onSurface = t.ink,
    surfaceVariant = t.surface3,
    onSurfaceVariant = t.muted,
    // cards white on the grey page, as the console
    surfaceContainerLowest = t.surface,
    surfaceContainerLow = t.surface,
    surfaceContainer = t.surface2,
    surfaceContainerHigh = t.surface3,
    surfaceContainerHighest = t.line,
    surfaceBright = t.surface,
    surfaceDim = t.surface3,
    outline = t.lineStrong,
    outlineVariant = t.line,
    inverseSurface = t.ink,
    inverseOnSurface = t.surface,
    inversePrimary = t.brand,
)

private fun darkScheme(t: ConsolePalette) = darkColorScheme(
    primary = t.brandInk,
    onPrimary = t.bg,
    primaryContainer = t.brandSoft,
    onPrimaryContainer = t.brandInk,
    secondary = t.muted,
    onSecondary = t.bg,
    secondaryContainer = t.brandSoft,
    onSecondaryContainer = t.brandInk,
    tertiary = t.info,
    onTertiary = t.bg,
    tertiaryContainer = t.infoBg,
    onTertiaryContainer = t.info,
    error = t.bad,
    onError = t.bg,
    errorContainer = t.badBg,
    onErrorContainer = t.bad,
    background = t.bg,
    onBackground = t.ink,
    surface = t.bg,
    onSurface = t.ink,
    surfaceVariant = t.surface3,
    onSurfaceVariant = t.muted,
    surfaceContainerLowest = t.bg,
    surfaceContainerLow = t.surface,
    surfaceContainer = t.surface2,
    surfaceContainerHigh = t.surface3,
    surfaceContainerHighest = t.line,
    surfaceBright = t.surface3,
    surfaceDim = t.bg,
    outline = t.lineStrong,
    outlineVariant = t.line,
    inverseSurface = t.ink,
    inverseOnSurface = t.surface,
    inversePrimary = t.brand,
)

private val Light = lightScheme(ConsoleTokens.Light)
private val Dark = darkScheme(ConsoleTokens.Dark)

/** The radii of the console: controls 8, cards and panels 16 (sheets and dialogs a bit more). */
private val CdaShapes = Shapes(
    extraSmall = RoundedCornerShape(ConsoleTokens.RADIUS_SM.dp),
    small = RoundedCornerShape(ConsoleTokens.RADIUS_SM.dp),
    medium = RoundedCornerShape(ConsoleTokens.RADIUS.dp),
    large = RoundedCornerShape(ConsoleTokens.RADIUS_LG.dp),
    extraLarge = RoundedCornerShape(24.dp),
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
