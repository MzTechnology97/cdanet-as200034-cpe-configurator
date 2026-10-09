package it.cdanet.cpeconfigurator.ui.screens

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.field.CompassMath
import it.cdanet.cpeconfigurator.field.CompassQuality
import it.cdanet.cpeconfigurator.field.CompassSensor
import it.cdanet.cpeconfigurator.field.FieldDiagnosis
import it.cdanet.cpeconfigurator.ui.BadRed
import it.cdanet.cpeconfigurator.ui.Banner
import it.cdanet.cpeconfigurator.ui.GoodGreen
import it.cdanet.cpeconfigurator.ui.KeyValue
import it.cdanet.cpeconfigurator.ui.SectionCard
import it.cdanet.cpeconfigurator.ui.WarnAmber
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * Compass towards the selected AP. Shows the direction only when the magnetometer is
 * calibrated and not disturbed; otherwise it says what to do (figure-8, move away from metal).
 */
@Composable
fun CompassScreen(c: AppContainer) {
    it.cdanet.cpeconfigurator.ui.KeepScreenOn()
    val target by c.compassTarget.collectAsState()
    val t = target ?: run {
        Text("Scegli un AP dalla Copertura e premi \"Bussola\".")
        return
    }
    val context = LocalContext.current
    val view = LocalView.current
    val sensor = remember { CompassSensor(context) }
    val reading by sensor.reading.collectAsState()
    DisposableEffect(t) {
        view.keepScreenOn = true
        sensor.start(t.fromLatitude, t.fromLongitude)
        onDispose {
            sensor.stop()
            view.keepScreenOn = false
        }
    }

    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (!sensor.available) {
            Banner("Questo telefono non ha il magnetometro: usa una bussola esterna (direzione ${t.bearing}°).", BadRed)
            return@Column
        }
        SectionCard(t.name) {
            KeyValue("Direzione dell'AP", "${t.bearing}° (Nord vero)")
            t.distanceM?.let { KeyValue("Distanza", FieldDiagnosis.formatDistance(it)) }
        }
        val r = reading
        if (r == null) {
            Text("Lettura dei sensori…")
            return@Column
        }
        val quality = CompassMath.quality(r)
        val delta = CompassMath.delta(r.heading, t.bearing.toDouble())
        val qColor = when (quality) { CompassQuality.Good -> GoodGreen; CompassQuality.Fair -> WarnAmber; CompassQuality.Poor -> BadRed }
        SectionCard {
            Text(
                if (quality == CompassQuality.Poor) "Bussola non affidabile" else CompassMath.turnAdvice(delta),
                fontSize = 30.sp,
                fontWeight = FontWeight.Bold,
                color = if (quality == CompassQuality.Poor) BadRed else if (abs(delta) <= 3) GoodGreen else MaterialTheme.colorScheme.onSurface,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth(),
            )
            CompassDial(heading = r.heading, target = t.bearing.toDouble(), reliable = quality != CompassQuality.Poor)
            Text(
                "Telefono verso ${r.heading.roundToInt()}° · AP a ${t.bearing}°",
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        SectionCard("Affidabilità") {
            Text(
                when (quality) { CompassQuality.Good -> "Buona"; CompassQuality.Fair -> "Discreta"; CompassQuality.Poor -> "Scarsa: non usare per il puntamento" },
                color = qColor,
                fontWeight = FontWeight.SemiBold,
            )
            CompassMath.warnings(r).forEach { Text("• $it", style = MaterialTheme.typography.bodySmall) }
            KeyValue("Calibrazione sensore", listOf("non affidabile", "bassa", "media", "alta").getOrElse(r.sensorAccuracy) { "?" })
            r.fieldMicroTesla?.let { KeyValue("Campo magnetico", "${it.roundToInt()} µT (atteso ~${r.expectedMicroTesla?.roundToInt() ?: "?"} µT)") }
            KeyValue("Declinazione applicata", "%+.1f°".format(r.declination))
            Text(
                "Tieni il telefono in piano, con la parte alta rivolta come l'antenna, ad almeno un metro da palo e staffa. " +
                    "Il puntamento fine si fa con il segnale (Puntamento antenna).",
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
}

/** Rose rotated with the phone (north up = real north) and a needle towards the AP. */
@Composable
private fun CompassDial(heading: Double, target: Double, reliable: Boolean) {
    val ink = MaterialTheme.colorScheme.onSurface
    val muted = MaterialTheme.colorScheme.outline
    val needle = if (reliable) GoodGreen else BadRed
    val cBadRed = BadRed
    Canvas(Modifier.fillMaxWidth().aspectRatio(1f)) {
        val cx = size.width / 2
        val cy = size.height / 2
        val rad = minOf(cx, cy) * 0.9f
        drawCircle(muted, rad, Offset(cx, cy), style = Stroke(width = 4f))
        rotate(-heading.toFloat(), Offset(cx, cy)) {
            for (deg in 0 until 360 step 30) {
                rotate(deg.toFloat(), Offset(cx, cy)) {
                    drawLine(if (deg == 0) cBadRed else ink, Offset(cx, cy - rad), Offset(cx, cy - rad + if (deg % 90 == 0) 40f else 20f), strokeWidth = if (deg == 0) 8f else 4f)
                }
            }
            rotate(target.toFloat(), Offset(cx, cy)) {
                val p = Path().apply {
                    moveTo(cx, cy - rad * 0.85f)
                    lineTo(cx - 28f, cy - rad * 0.55f)
                    lineTo(cx + 28f, cy - rad * 0.55f)
                    close()
                }
                drawLine(needle, Offset(cx, cy), Offset(cx, cy - rad * 0.6f), strokeWidth = 10f)
                drawPath(p, needle)
            }
        }
        // fixed index: where the phone (antenna) points
        drawLine(ink, Offset(cx, cy - rad - 10f), Offset(cx, cy - rad + 50f), strokeWidth = 6f)
    }
}
