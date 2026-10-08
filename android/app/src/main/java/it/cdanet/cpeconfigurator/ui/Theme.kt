package it.cdanet.cpeconfigurator.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

val CdaOrange = Color(0xFFF47B20)
val GoodGreen = Color(0xFF1A7F4B)
val BadRed = Color(0xFFB42318)
val WarnAmber = Color(0xFF9A6200)

private val Light = lightColorScheme(
    primary = CdaOrange,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFFFE3CF),
    onPrimaryContainer = Color(0xFF5A2600),
    secondary = Color(0xFF3B4250),
    background = Color(0xFFF4F5F7),
    surface = Color.White,
    surfaceVariant = Color(0xFFF0F1F4),
    error = BadRed,
)

private val Dark = darkColorScheme(
    primary = Color(0xFFFF9A52),
    onPrimary = Color(0xFF3A1A00),
    primaryContainer = Color(0xFF5A2E0B),
    onPrimaryContainer = Color(0xFFFFDCC4),
    background = Color(0xFF111317),
    surface = Color(0xFF1A1D22),
    surfaceVariant = Color(0xFF23272E),
    error = Color(0xFFFF8A80),
)

@Composable
fun CdaTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = if (isSystemInDarkTheme()) Dark else Light, content = content)
}
