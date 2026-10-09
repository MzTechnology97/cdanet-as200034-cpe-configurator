package it.cdanet.cpeconfigurator.ui.screens

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.unit.dp
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.data.JobDto
import it.cdanet.cpeconfigurator.data.SeriesDto
import it.cdanet.cpeconfigurator.data.SignalHistoryDto
import it.cdanet.cpeconfigurator.ui.BadRed
import it.cdanet.cpeconfigurator.ui.GoodGreen
import it.cdanet.cpeconfigurator.ui.KeyValue
import it.cdanet.cpeconfigurator.ui.WarnAmber
import kotlin.math.abs
import kotlin.math.roundToInt

/** Last 7 days of signal from UISP for the CPE of a job: sudden failure or slow degradation? */
@Composable
fun SignalHistory(c: AppContainer, job: JobDto) {
    var data by remember { mutableStateOf<SignalHistoryDto?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(job.id) {
        runCatching { c.api.signalHistory(job.id, "week") }.onSuccess { data = it }.onFailure { error = it.message }
    }
    val d = data
    Column {
        when {
            error != null -> Text("Storico non disponibile: $error", style = MaterialTheme.typography.bodySmall, color = BadRed)
            d == null -> Text("Lettura storico…", style = MaterialTheme.typography.bodySmall)
            d.signal.points.isEmpty() -> Text("Nessun dato di segnale negli ultimi 7 giorni.", style = MaterialTheme.typography.bodySmall)
            else -> {
                SeriesChart(d.signal, d.remoteSignal)
                KeyValue("Segnale min / medio / max", "${d.signal.min?.roundToInt()} / ${d.signal.avg?.roundToInt()} / ${d.signal.max?.roundToInt()} dBm")
                d.downlinkCapacity.avg?.let { KeyValue("Capacità media", "${(it / 1000).roundToInt()} / ${((d.uplinkCapacity.avg ?: 0.0) / 1000).roundToInt()} Mbit/s") }
                d.outages?.let { KeyValue("Interruzioni (7 giorni)", it.size.toString()) }
                d.signal.trend?.let { t ->
                    when {
                        t <= -4 -> Text("Calo di ${abs(t).roundToInt()} dB nella settimana: degrado lento (vegetazione, antenna spostata, staffa allentata).", color = WarnAmber, style = MaterialTheme.typography.bodySmall)
                        t >= 4 -> Text("Segnale migliorato di ${t.roundToInt()} dB nella settimana.", color = GoodGreen, style = MaterialTheme.typography.bodySmall)
                        else -> Text("Segnale stabile nella settimana: se ora c'è un guasto è recente.", style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        }
    }
}

@Composable
private fun SeriesChart(signal: SeriesDto, remote: SeriesDto) {
    val line = MaterialTheme.colorScheme.primary
    val muted = MaterialTheme.colorScheme.outline
    Canvas(Modifier.fillMaxWidth().height(110.dp)) {
        val pts = signal.points.mapNotNull { p -> if (p.size >= 2) p[0] to p[1] else null }
        val rpts = remote.points.mapNotNull { p -> if (p.size >= 2) p[0] to p[1] else null }
        if (pts.size < 2) return@Canvas
        val t0 = pts.first().first
        val t1 = pts.last().first.coerceAtLeast(t0 + 1)
        val all = (pts + rpts).map { it.second }
        val lo = minOf(-80.0, all.min()) - 2
        val hi = maxOf(-45.0, all.max()) + 2
        fun x(t: Double) = ((t - t0) / (t1 - t0) * size.width).toFloat()
        fun y(v: Double) = ((hi - v) / (hi - lo) * size.height).toFloat()
        val dash = PathEffect.dashPathEffect(floatArrayOf(10f, 10f))
        drawLine(GoodGreen, Offset(0f, y(-65.0)), Offset(size.width, y(-65.0)), pathEffect = dash)
        drawLine(BadRed, Offset(0f, y(-75.0)), Offset(size.width, y(-75.0)), pathEffect = dash)
        rpts.zipWithNext().forEach { (a, b) -> drawLine(muted, Offset(x(a.first), y(a.second)), Offset(x(b.first), y(b.second)), strokeWidth = 2f) }
        pts.zipWithNext().forEach { (a, b) -> drawLine(line, Offset(x(a.first), y(a.second)), Offset(x(b.first), y(b.second)), strokeWidth = 4f) }
    }
}
