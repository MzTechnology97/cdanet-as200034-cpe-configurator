package it.cdanet.cpeconfigurator.ui

import androidx.compose.ui.graphics.Color

/**
 * The colours of the data (maps, charts, legends), the same as the console's
 * (console/src/pages/CoverageAdmin.tsx and the maps): they mean a value or a kind of thing, so they
 * stay the same in light and dark. The colours of the interface come from ConsoleTokens instead.
 */
object DataColors {
    val Excellent = Color(0xFF15803D)
    val Good = Color(0xFF22C55E)
    val Fair = Color(0xFFA3E635)
    val Weak = Color(0xFFFACC15)
    val Poor = Color(0xFFF97316)
    val Unusable = Color(0xFFDC2626)

    /** Expected signal of the coverage simulation, from excellent to below the minimum. */
    val SignalScale = listOf(
        Excellent to "oltre −60 dBm",
        Good to "−60…−65",
        Fair to "−65…−70",
        Weak to "−70…−75",
        Poor to "−75…−80 (sotto il minimo)",
    )

    /** Downlink capacity of the radio link. */
    val CapacityScale = listOf(
        Excellent to "oltre 150 Mbit/s",
        Good to "100–150",
        Fair to "50–100",
        Weak to "25–50",
        Poor to "10–25",
        Unusable to "sotto 10",
    )

    /** Profile of a link: the line of sight, the Fresnel zone, the CPE end and the vegetation. */
    val LineOfSight = Color(0xFF2563EB)
    val Fresnel = Color(0xFF38BDF8)
    val CpeEnd = Poor
    /** The AP end of a link (B of the simulation A → B), blue as on the console's map. */
    val ApEnd = Color(0xFF2563EB)
    val Vegetation = Color(0xFF2E7D32)

    /** Distinct colours for series with no meaning of their own (Wi-Fi networks of a chart). */
    val Series = listOf(
        Color(0xFF0EA5E9), Color(0xFFF59E0B), Color(0xFF22C55E), Color(0xFFEF4444), Color(0xFFA855F7), Color(0xFF14B8A6),
        Color(0xFFEC4899), Color(0xFF84CC16), Color(0xFF6366F1), Color(0xFFF97316), Color(0xFF06B6D4), Color(0xFFE11D48),
    )
}
