package it.cdanet.cpeconfigurator.ui.screens

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.field.ArMath
import it.cdanet.cpeconfigurator.field.ArOrientation
import it.cdanet.cpeconfigurator.field.CompassTarget
import it.cdanet.cpeconfigurator.field.FieldDiagnosis
import it.cdanet.cpeconfigurator.field.AlignmentTone
import it.cdanet.cpeconfigurator.field.FieldMode
import it.cdanet.cpeconfigurator.field.Verdict
import kotlin.math.abs
import kotlin.math.atan
import kotlin.math.atan2
import kotlin.math.roundToInt

private val Aim = Color(0xFF29B6F6)
private val Ok = Color(0xFF34D399)

private tailrec fun Context.activity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.activity()
    else -> null
}

/** Field of view of the back camera (long and short side of the sensor), degrees; typical values if unknown. */
private fun backCameraFov(context: Context): Pair<Double, Double> = runCatching {
    val cm = context.getSystemService(CameraManager::class.java)
    val id = cm.cameraIdList.first { cm.getCameraCharacteristics(it).get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_BACK }
    val ch = cm.getCameraCharacteristics(id)
    val size = ch.get(CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE)!!
    val f = ch.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)!!.first()
    val long = Math.toDegrees(2 * atan(maxOf(size.width, size.height) / (2.0 * f)))
    val short = Math.toDegrees(2 * atan(minOf(size.width, size.height) / (2.0 * f)))
    long to short
}.getOrDefault(66.0 to 52.0)

/**
 * Camera sight towards an AP: the live view of the back camera with the AP's position drawn where
 * it is (azimuth + tilt), arrows when it is off screen and the reticle turning green when aligned.
 * Portrait only while open (the drawing assumes it).
 */
@Composable
fun ArAimScreen(c: AppContainer, liveSignal: Boolean = false) {
    it.cdanet.cpeconfigurator.ui.KeepScreenOn()
    val target by c.compassTarget.collectAsState()
    val t = target ?: run {
        Text("Scegli un AP da \"Trova l'AP\".", Modifier.padding(14.dp))
        return
    }
    val context = LocalContext.current
    var granted by remember { mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted = it }
    LaunchedEffect(Unit) { if (!granted) ask.launch(Manifest.permission.CAMERA) }
    if (!granted) {
        Column(Modifier.padding(14.dp)) {
            Text("Per il mirino serve il permesso della fotocamera.")
            TextButton(onClick = { ask.launch(Manifest.permission.CAMERA) }) { Text("Consenti fotocamera") }
        }
        return
    }

    val view = LocalView.current
    val orientation = remember { ArOrientation(context) }
    val state by orientation.state.collectAsState()
    val fov = remember { backCameraFov(context) }
    DisposableEffect(t) {
        val activity = context.activity()
        val before = activity?.requestedOrientation
        activity?.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        orientation.start(t.fromLatitude, t.fromLongitude)
        // from the guided installation: live signal of the CPE with the alignment beep
        val tone = if (liveSignal) AlignmentTone() else null
        if (tone != null) {
            c.field.onSample = { smp -> tone.beep(smp.signal) }
            c.field.start(FieldMode.Alignment)
        }
        onDispose {
            if (tone != null) {
                c.field.onSample = null
                c.field.stop()
            }
            orientation.stop()
            if (activity != null && before != null) activity.requestedOrientation = before
        }
    }

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        CameraPreview(Modifier.fillMaxSize())
        val s = state
        val tilt = t.tiltDeg ?: 0.0
        val aim = s?.let { ArMath.aim(it.r, t.bearing.toDouble(), tilt, it.declination) }
        val aligned = aim != null && ArMath.aligned(aim)
        val haptic = LocalHapticFeedback.current
        LaunchedEffect(aligned) { if (aligned) haptic.performHapticFeedback(HapticFeedbackType.LongPress) }

        Canvas(Modifier.fillMaxSize()) {
            val cx = size.width / 2
            val cy = size.height / 2
            val color = if (aligned) Ok else Aim
            // reticle
            val r = size.minDimension * 0.16f
            drawCircle(color, r, Offset(cx, cy), style = Stroke(width = 5f))
            drawCircle(color, r * 0.18f, Offset(cx, cy), style = Stroke(width = 3f))
            val k = r * 1.35f
            val l = r * 0.35f
            for ((sx, sy) in listOf(-1f to -1f, 1f to -1f, -1f to 1f, 1f to 1f)) {
                drawLine(color, Offset(cx + sx * k, cy + sy * k), Offset(cx + sx * (k - l), cy + sy * k), strokeWidth = 6f)
                drawLine(color, Offset(cx + sx * k, cy + sy * k), Offset(cx + sx * k, cy + sy * (k - l)), strokeWidth = 6f)
            }
            if (aim == null) return@Canvas
            val f = ArMath.focalPixels(size.width, size.height, fov.first, fov.second).toFloat()
            val px = if (aim.forward > 0) cx + f * (aim.x / aim.forward).toFloat() else Float.NaN
            val py = if (aim.forward > 0) cy - f * (aim.y / aim.forward).toFloat() else Float.NaN
            val onScreen = aim.forward > 0 && px in 0f..size.width && py in 0f..size.height
            if (onScreen) {
                drawCircle(color, 26f, Offset(px, py), style = Stroke(width = 6f))
                drawCircle(color.copy(alpha = 0.35f), 26f, Offset(px, py))
            } else {
                // arrow on the edge, towards the AP
                val ang = Math.toDegrees(atan2(-aim.y, aim.x)).toFloat() // screen angle, 0 = right
                val edge = size.minDimension * 0.42f
                val ex = cx + edge * kotlin.math.cos(Math.toRadians(ang.toDouble())).toFloat()
                val ey = cy + edge * kotlin.math.sin(Math.toRadians(ang.toDouble())).toFloat()
                rotate(ang + 90f, Offset(ex, ey)) {
                    val p = Path().apply {
                        moveTo(ex, ey - 40f)
                        lineTo(ex - 32f, ey + 20f)
                        lineTo(ex + 32f, ey + 20f)
                        close()
                    }
                    drawPath(p, color)
                }
            }
        }

        val shadow = Modifier.background(Color.Black.copy(alpha = 0.35f)).padding(horizontal = 8.dp, vertical = 4.dp)
        Column(Modifier.align(Alignment.TopStart).padding(12.dp).then(shadow)) {
            Text(t.name, color = Color.White, fontWeight = FontWeight.SemiBold, fontSize = 18.sp)
            t.altitude?.let { Text("${it.roundToInt()} m s.l.m.", color = Color.White) }
        }
        Column(Modifier.align(Alignment.TopEnd).padding(12.dp).then(shadow), horizontalAlignment = Alignment.End) {
            t.fromAltitude?.let { Text("Tu: ${it.roundToInt()} m s.l.m.", color = Color.White) }
            t.distanceM?.let { Text(FieldDiagnosis.formatDistance(it), color = Color.White) }
        }
        Column(Modifier.align(Alignment.BottomStart).fillMaxWidth().padding(12.dp)) {
            if (liveSignal) {
                val f by c.field.state.collectAsState()
                val sig = f.status?.signal
                val v = FieldDiagnosis.signalVerdict(sig, c.field.thresholds)
                Text(
                    sig?.let { "Segnale CPE $it dBm" + (f.peak?.let { p -> " · picco $p" } ?: "") } ?: if (f.status?.associated == false) "CPE non agganciata" else "Lettura del segnale della CPE…",
                    color = when (v) { Verdict.Ok -> Ok; Verdict.Warn -> Color(0xFFFFC107); else -> Color(0xFFFF6B5E) },
                    fontSize = 26.sp,
                    fontWeight = FontWeight.Bold,
                    modifier = shadow,
                )
            }
            if (s != null && s.accuracy <= 1) {
                Text("Bussola non calibrata: muovi il telefono disegnando un 8", color = Color.White, modifier = Modifier.background(Color(0xCCB42318)).padding(6.dp))
            }
            if (aim != null) {
                Text(
                    if (aligned) "Allineato" else listOfNotNull(
                        aim.yawOffset.takeIf { abs(it) > 2 }?.let { if (it > 0) "gira a destra ${it.roundToInt()}°" else "gira a sinistra ${(-it).roundToInt()}°" },
                        aim.pitchOffset.takeIf { abs(it) > 2 }?.let { if (it > 0) "alza ${it.roundToInt()}°" else "abbassa ${(-it).roundToInt()}°" },
                    ).joinToString(" · "),
                    color = if (aligned) Ok else Color.White,
                    fontSize = 20.sp,
                    fontWeight = FontWeight.Bold,
                    modifier = shadow,
                )
                Text(
                    "Azimut verso AP: ${t.bearing}° (telefono ${aim.cameraAzimuth.roundToInt()}°) · Tilt richiesto: ${"%.1f".format(java.util.Locale.ITALY, tilt)}° (telefono ${aim.cameraElevation.roundToInt()}°)",
                    color = Color.White,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = shadow,
                )
            }
        }
    }
}

/** Back camera live preview (CameraX), bound to the screen's lifecycle. */
@Composable
private fun CameraPreview(modifier: Modifier) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    val previewView = remember { PreviewView(context).apply { scaleType = PreviewView.ScaleType.FILL_CENTER } }
    DisposableEffect(owner) {
        val future = ProcessCameraProvider.getInstance(context)
        var provider: ProcessCameraProvider? = null
        future.addListener({
            provider = future.get().also { p ->
                val preview = Preview.Builder().build().also { it.setSurfaceProvider(previewView.surfaceProvider) }
                p.unbindAll()
                runCatching { p.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, preview) }
            }
        }, ContextCompat.getMainExecutor(context))
        onDispose { provider?.unbindAll() }
    }
    AndroidView(factory = { previewView }, modifier = modifier)
}
