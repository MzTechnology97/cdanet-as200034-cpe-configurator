package it.cdanet.cpeconfigurator.ui.screens

import android.Manifest
import android.app.Activity
import android.content.ContentValues
import android.content.Context
import android.content.ContextWrapper
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.os.Build
import android.provider.MediaStore
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.CanvasDrawScope
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.data.LosDto
import it.cdanet.cpeconfigurator.field.AlignmentTone
import it.cdanet.cpeconfigurator.field.ArBeacon
import it.cdanet.cpeconfigurator.field.ArHorizon
import it.cdanet.cpeconfigurator.field.ArMath
import it.cdanet.cpeconfigurator.field.ArOrientation
import it.cdanet.cpeconfigurator.field.ArScene
import it.cdanet.cpeconfigurator.field.CompassMath
import it.cdanet.cpeconfigurator.field.FieldDiagnosis
import it.cdanet.cpeconfigurator.field.FieldMode
import it.cdanet.cpeconfigurator.field.FresnelRing
import it.cdanet.cpeconfigurator.field.Verdict
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.abs
import kotlin.math.atan
import kotlin.math.atan2
import kotlin.math.roundToInt
import kotlin.math.tan

private val Aim = Color(0xFF29B6F6)
private val Ok = Color(0xFF34D399)
private val Bad = Color(0xFFFF5A4E)
private val Warn = Color(0xFFFFC107)
private val Sky = Color(0xFF7DF9FF)

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

/** Colour of an AP by the verdict of the check, else by its expected signal. */
private fun beaconColor(b: ArBeacon): Color = when (b.rating) {
    "buono" -> Ok
    "possibile" -> Warn
    "improbabile" -> Bad
    "non attivo" -> Color(0xFF9CA3AF)
    else -> when {
        b.signalDbm == null -> Color(0xFFE5E7EB)
        b.signalDbm >= -65 -> Ok
        b.signalDbm >= -75 -> Warn
        else -> Bad
    }
}

private fun km(m: Int) = FieldDiagnosis.formatDistance(m)

/** Everything drawn over the camera: the same for the screen and for the photo. */
private class ArFrame(
    val r: FloatArray,
    /** Declination plus the calibration of the compass (skyline or drag). */
    val decl: Double,
    val fov: Pair<Double, Double>,
    val beacons: List<ArBeacon>,
    val selected: ArBeacon?,
    val selectedTilt: Double,
    val rings: List<FresnelRing>,
    val horizon: ArHorizon?,
    val aligned: Boolean,
)

private data class Hit(val rect: Rect, val id: String?)

/**
 * The scene over the camera: the terrain skyline (what the model knows: what rises above it in
 * the picture are buildings and trees), the APs as beacons on their direction, the Fresnel tunnel
 * towards the chosen AP (red rings where the profile says something enters it), the compass tape
 * on top. [hits] collects where the labels are, for the taps.
 */
private fun DrawScope.drawArScene(fr: ArFrame, tm: TextMeasurer, hits: MutableList<Hit>?) {
    val cx = size.width / 2
    val cy = size.height / 2
    val f = ArMath.focalPixels(size.width, size.height, fr.fov.first, fr.fov.second).toFloat()
    fun project(az: Double, el: Double): Offset? {
        val v = ArMath.aim(fr.r, az, el, fr.decl)
        if (v.forward <= 0.05) return null
        return Offset(cx + f * (v.x / v.forward).toFloat(), cy - f * (v.y / v.forward).toFloat())
    }
    val camAz = ArMath.aim(fr.r, 0.0, 0.0, fr.decl).cameraAzimuth
    val label = TextStyle(color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
    val small = TextStyle(color = Color.White, fontSize = 11.sp)

    // --- skyline of the terrain model, the ground below it veiled
    fr.horizon?.let { hz ->
        val pts = ArrayList<Offset?>()
        var az = camAz - 75
        while (az <= camAz + 75) {
            pts += project(az, hz.at(az))
            az += 0.5
        }
        val runs = ArrayList<List<Offset>>()
        var cur = ArrayList<Offset>()
        for (p in pts) if (p == null) { if (cur.size > 1) runs += cur; cur = ArrayList() } else cur += p
        if (cur.size > 1) runs += cur
        for (run in runs) {
            val fill = Path().apply {
                moveTo(run.first().x, size.height)
                run.forEach { lineTo(it.x, it.y) }
                lineTo(run.last().x, size.height)
                close()
            }
            drawPath(fill, Sky.copy(alpha = 0.10f))
            val line = Path().apply { moveTo(run.first().x, run.first().y); run.drop(1).forEach { lineTo(it.x, it.y) } }
            drawPath(line, Color.Black.copy(alpha = 0.45f), style = Stroke(width = 7f))
            drawPath(line, Sky, style = Stroke(width = 3.5f))
        }
        // the highest point of the skyline in view: how far the ridge is
        var bestAz = Double.NaN
        var bestEl = -90.0
        var a = camAz - 25
        while (a <= camAz + 25) {
            val e = hz.at(a)
            if (e > bestEl) { bestEl = e; bestAz = a }
            a += 0.5
        }
        if (!bestAz.isNaN()) project(bestAz, bestEl)?.let { p ->
            val t = tm.measure("▲ cresta a ${km(hz.distanceAt(bestAz))}", small)
            drawText(t, topLeft = Offset(p.x - t.size.width / 2f, p.y - t.size.height - 6f))
        }
    }

    // --- the Fresnel tunnel towards the chosen AP
    val sel = fr.selected
    if (sel != null) {
        project(sel.bearing, fr.selectedTilt)?.let { c ->
            val shown = fr.rings.sortedByDescending { it.distanceM }
            val firstHit = fr.rings.firstOrNull { it.invaded }
            val labelled = setOfNotNull(fr.rings.firstOrNull(), firstHit, fr.rings.lastOrNull { !it.invaded && it.distanceM >= 1000 })
            val used = ArrayList<Rect>()
            // the tube in perspective: four lines from the nearest ring to the AP
            fr.rings.firstOrNull()?.let { near ->
                val rad = (f * tan(Math.toRadians(near.radiusDeg))).toFloat()
                for (k in 0 until 4) {
                    val a = Math.PI / 4 + k * Math.PI / 2
                    drawLine(Ok.copy(alpha = 0.35f), Offset(c.x + rad * kotlin.math.cos(a).toFloat(), c.y + rad * kotlin.math.sin(a).toFloat()), c, 2f)
                }
            }
            for ((i, ring) in shown.withIndex()) {
                val rad = (f * tan(Math.toRadians(ring.radiusDeg))).toFloat().coerceAtMost(size.maxDimension)
                val col = if (ring.invaded) Bad else Ok
                val alpha = 0.35f + 0.5f * i / shown.size.coerceAtLeast(1)
                drawCircle(col.copy(alpha = alpha * 0.18f), rad, c)
                drawCircle(col.copy(alpha = alpha), rad, c, style = Stroke(width = if (ring.invaded) 4f else 2.5f, pathEffect = if (ring.distanceM > 1000) PathEffect.dashPathEffect(floatArrayOf(12f, 10f)) else null))
                // the distance on the rings big enough to read
                if (ring in labelled) {
                    val txt = (if (ring.invaded) "⚠ " else "") + km(ring.distanceM) + (if (ring.invaded) " · ${ring.obstacle}" else "")
                    val t = tm.measure(txt, small.copy(color = col, fontWeight = FontWeight.Bold))
                    var tl = Offset(c.x + rad * 0.72f + 6f, c.y - rad * 0.72f - t.size.height)
                    while (used.any { it.overlaps(Rect(tl, Size(t.size.width.toFloat(), t.size.height.toFloat()))) }) tl = tl.copy(y = tl.y - t.size.height - 2f)
                    used += Rect(tl, Size(t.size.width.toFloat(), t.size.height.toFloat()))
                    drawRoundRect(Color.Black.copy(alpha = 0.55f), tl - Offset(4f, 1f), Size(t.size.width + 8f, t.size.height + 2f), androidx.compose.ui.geometry.CornerRadius(6f))
                    drawText(t, topLeft = tl)
                }
            }
        }
    }

    // --- the APs as beacons: a light pole from below the horizon to a label
    val placed = ArrayList<Rect>()
    for (b in fr.beacons.sortedBy { sel != null && it.id == sel.id }) {
        val isSel = sel != null && b.id == sel.id
        // the chosen AP where it really is (below the skyline: hidden by the hill); the others, when
        // their tilt is unknown, on the skyline of their direction
        val el = if (isSel) fr.selectedTilt else b.tiltDeg ?: fr.horizon?.at(b.bearing)?.plus(0.3) ?: 0.0
        val p = project(b.bearing, el) ?: continue
        if (p.x < -200 || p.x > size.width + 200) continue
        val col = beaconColor(b)
        var top = p.y - (if (isSel) 150f else 105f)
        drawCircle(col, if (isSel) 13f else 9f, p)
        drawCircle(Color.Black.copy(alpha = 0.6f), if (isSel) 13f else 9f, p, style = Stroke(2f))
        val line1 = tm.measure(b.name, label)
        val line2 = tm.measure(listOfNotNull(b.distanceM?.let { km(it) }, b.signalDbm?.let { "$it dBm" }, b.rating).joinToString(" · "), small)
        val w = maxOf(line1.size.width, line2.size.width) + 18f
        val h = line1.size.height + line2.size.height + 10f
        var tl = Offset(p.x - w / 2, top - h)
        while (placed.any { it.overlaps(Rect(tl, Size(w, h))) }) tl = tl.copy(y = tl.y - h - 6f)
        placed += Rect(tl, Size(w, h))
        top = tl.y + h
        drawLine(col, Offset(p.x, top), Offset(p.x, p.y + 30f), if (isSel) 5f else 3f)
        drawRoundRect(Color.Black.copy(alpha = if (isSel) 0.78f else 0.6f), tl, Size(w, h), androidx.compose.ui.geometry.CornerRadius(12f))
        drawRoundRect(col, tl, Size(w, h), androidx.compose.ui.geometry.CornerRadius(12f), style = Stroke(if (isSel) 4f else 2f))
        drawText(line1, topLeft = Offset(tl.x + 9f, tl.y + 4f))
        drawText(line2, topLeft = Offset(tl.x + 9f, tl.y + 6f + line1.size.height))
        hits?.add(Hit(Rect(tl, Size(w, h + (p.y - top))), b.id))
    }

    // --- reticle (green when aimed at the chosen AP) and the arrow when it is off screen
    val color = if (fr.aligned) Ok else Aim
    val rr = size.minDimension * 0.07f
    drawCircle(color, rr, Offset(cx, cy), style = Stroke(width = 4f))
    drawLine(color, Offset(cx - rr * 1.6f, cy), Offset(cx - rr * 0.6f, cy), 4f)
    drawLine(color, Offset(cx + rr * 0.6f, cy), Offset(cx + rr * 1.6f, cy), 4f)
    drawLine(color, Offset(cx, cy - rr * 1.6f), Offset(cx, cy - rr * 0.6f), 4f)
    drawLine(color, Offset(cx, cy + rr * 0.6f), Offset(cx, cy + rr * 1.6f), 4f)
    if (sel != null) {
        val v = ArMath.aim(fr.r, sel.bearing, fr.selectedTilt, fr.decl)
        val px = if (v.forward > 0) cx + f * (v.x / v.forward).toFloat() else Float.NaN
        val py = if (v.forward > 0) cy - f * (v.y / v.forward).toFloat() else Float.NaN
        if (!(v.forward > 0 && px in 0f..size.width && py in 0f..size.height)) {
            val ang = Math.toDegrees(atan2(-v.y, v.x)).toFloat()
            val edge = size.minDimension * 0.40f
            val ex = cx + edge * kotlin.math.cos(Math.toRadians(ang.toDouble())).toFloat()
            val ey = cy + edge * kotlin.math.sin(Math.toRadians(ang.toDouble())).toFloat()
            rotate(ang + 90f, Offset(ex, ey)) {
                drawPath(Path().apply { moveTo(ex, ey - 40f); lineTo(ex - 32f, ey + 20f); lineTo(ex + 32f, ey + 20f); close() }, color)
            }
        }
    }

    // --- compass tape: ±60° around where the camera looks, the APs on it
    val tapeH = 64f
    drawRect(Color.Black.copy(alpha = 0.5f), Offset.Zero, Size(size.width, tapeH))
    val pxPerDeg = size.width / 120f
    var d = (kotlin.math.floor((camAz - 60) / 5) * 5)
    while (d <= camAz + 60) {
        val x = cx + ((d - camAz) * pxPerDeg).toFloat()
        val n = CompassMath.normalize(d).roundToInt() % 360
        val major = n % 30 == 0
        drawLine(Color.White.copy(alpha = if (major) 0.9f else 0.45f), Offset(x, tapeH - (if (major) 22f else 12f)), Offset(x, tapeH), 2f)
        if (major) {
            val name = when (n) { 0 -> "N"; 90 -> "E"; 180 -> "S"; 270 -> "O"; else -> "$n" }
            val t = tm.measure(name, small.copy(fontWeight = if (n % 90 == 0) FontWeight.Bold else FontWeight.Normal))
            drawText(t, topLeft = Offset(x - t.size.width / 2f, 4f))
        }
        d += 5
    }
    for (b in fr.beacons) {
        var delta = CompassMath.normalize(b.bearing - camAz + 180) - 180
        val off = abs(delta) > 60
        delta = delta.coerceIn(-60.0, 60.0)
        val x = cx + (delta * pxPerDeg).toFloat()
        val col = beaconColor(b)
        val tri = Path().apply { moveTo(x, tapeH - 2f); lineTo(x - 9f, tapeH - 18f); lineTo(x + 9f, tapeH - 18f); close() }
        drawPath(tri, if (off) col.copy(alpha = 0.45f) else col)
        if (sel != null && b.id == sel.id) drawCircle(Color.White, 5f, Offset(x, tapeH - 26f))
    }
    drawLine(Color.White, Offset(cx, 0f), Offset(cx, tapeH), 3f)
}

/** Saves [bmp] in Pictures/CDA Net (or the app's pictures on Android 9 and older); the place, or null. */
private fun savePhoto(context: Context, bmp: Bitmap, name: String): String? = runCatching {
    val file = "AR_${name.replace(Regex("[^A-Za-z0-9_-]"), "_")}_${System.currentTimeMillis() / 1000}.jpg"
    if (Build.VERSION.SDK_INT >= 29) {
        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, file)
            put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg")
            put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/CDA Net")
        }
        val uri = context.contentResolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)!!
        context.contentResolver.openOutputStream(uri)!!.use { bmp.compress(Bitmap.CompressFormat.JPEG, 90, it) }
        "Galleria › Pictures/CDA Net"
    } else {
        val dir = context.getExternalFilesDir(android.os.Environment.DIRECTORY_PICTURES)!!
        java.io.File(dir, file).outputStream().use { bmp.compress(Bitmap.CompressFormat.JPEG, 90, it) }
        dir.absolutePath
    }
}.getOrNull()

/** A frame of the camera for the skyline: small, portrait, 0xRRGGBB. */
private class Frame(val rgb: IntArray, val w: Int, val h: Int)

private fun ImageProxy.toPortraitRgb(maxWidth: Int = 120): Frame {
    val plane = planes[0]
    val buf = plane.buffer
    val rs = plane.rowStride
    val ps = plane.pixelStride
    val rot = imageInfo.rotationDegrees
    val iw = width
    val ih = height
    val pw = if (rot == 90 || rot == 270) ih else iw
    val ph = if (rot == 90 || rot == 270) iw else ih
    val step = maxOf(1, pw / maxWidth)
    val w = pw / step
    val h = ph / step
    val out = IntArray(w * h)
    for (v in 0 until h) for (u in 0 until w) {
        val pu = u * step
        val pv = v * step
        val (x, y) = when (rot) {
            90 -> pv to (ih - 1 - pu)
            180 -> (iw - 1 - pu) to (ih - 1 - pv)
            270 -> (iw - 1 - pv) to pu
            else -> pu to pv
        }
        val o = y * rs + x * ps
        val r = buf.get(o).toInt() and 255
        val g = buf.get(o + 1).toInt() and 255
        val b = buf.get(o + 2).toInt() and 255
        out[v * w + u] = (r shl 16) or (g shl 8) or b
    }
    return Frame(out, w, h)
}

/**
 * Augmented reality on site: the live view of the back camera with the APs around as beacons
 * (name, distance, expected signal), the skyline of the terrain model, the Fresnel tunnel towards
 * the chosen AP (from the server profile), the compass tape and the reticle turning green when
 * aimed. The compass is corrected by laying the real skyline of the camera on the terrain one
 * (automatic) or by dragging. A photo keeps the picture with everything drawn on it.
 * Portrait only while open (the drawing assumes it).
 */
@Composable
fun ArAimScreen(c: AppContainer, liveSignal: Boolean = false) {
    it.cdanet.cpeconfigurator.ui.KeepScreenOn()
    val target by c.compassTarget.collectAsState()
    val t = target ?: run {
        Text("Scegli un AP da \"Trova l'AP\" o da Copertura.", Modifier.padding(14.dp))
        return
    }
    val context = LocalContext.current
    var granted by remember { mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted = it }
    LaunchedEffect(Unit) { if (!granted) ask.launch(Manifest.permission.CAMERA) }
    if (!granted) {
        Column(Modifier.padding(14.dp)) {
            Text("Per la realtà aumentata serve il permesso della fotocamera.")
            TextButton(onClick = { ask.launch(Manifest.permission.CAMERA) }) { Text("Consenti fotocamera") }
        }
        return
    }

    val scope = rememberCoroutineScope()
    val orientation = remember { ArOrientation(context) }
    val state by orientation.state.collectAsState()
    val fov = remember { backCameraFov(context) }
    val tm = rememberTextMeasurer()
    val density = LocalDensity.current
    val haptic = LocalHapticFeedback.current

    // the target among the beacons (the list may not have it: Trova l'AP from the installation)
    val main = remember(t) { ArBeacon(t.apId, t.name, t.bearing.toDouble(), t.tiltDeg, t.distanceM, null, null) }
    val beacons = remember(t) { (t.beacons.ifEmpty { listOf(main) }).let { list -> if (t.apId != null && list.none { it.id == t.apId }) list + main else list } }
    var selectedId by remember(t) { mutableStateOf(t.apId) }
    val selected = beacons.firstOrNull { it.id == selectedId } ?: main
    var offset by remember(t) { mutableDoubleStateOf(0.0) }
    var horizon by remember(t) { mutableStateOf<ArHorizon?>(null) }
    var los by remember { mutableStateOf<LosDto?>(null) }
    var note by remember { mutableStateOf<String?>(null) }
    var auto by remember { mutableStateOf(false) }
    val grab = remember { AtomicReference<((Frame) -> Unit)?>(null) }
    val preview = remember { mutableStateOf<PreviewView?>(null) }
    var canvasSize by remember { mutableStateOf(IntSize.Zero) }
    val hits = remember { ArrayList<Hit>() }

    DisposableEffect(t) {
        val activity = context.activity()
        val before = activity?.requestedOrientation
        activity?.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        orientation.start(t.fromLatitude, t.fromLongitude)
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
    // the skyline of the terrain from here (server; without it the rest still works)
    LaunchedEffect(t.fromLatitude, t.fromLongitude, t.heightM) {
        runCatching { c.api.horizon(t.fromLatitude, t.fromLongitude, t.heightM) }
            .onSuccess { h -> if (h.el.isNotEmpty()) horizon = ArHorizon(h.stepDeg, h.el.toDoubleArray(), h.dist.toIntArray()) }
    }
    // the profile towards the chosen AP: the Fresnel tunnel and its verdict
    LaunchedEffect(selectedId) {
        los = null
        val id = selectedId ?: return@LaunchedEffect
        runCatching { c.api.lineOfSight(t.fromLatitude, t.fromLongitude, id, t.heightM) }.onSuccess { los = it }
    }
    val rings = remember(los) {
        val ch = los?.chart.orEmpty()
        if (ch.size < 2) emptyList() else ArScene.fresnelRings(
            ch.map { it.d }.toIntArray(),
            ch.map { it.los }.toDoubleArray(),
            ch.map { it.fresnel60 }.toDoubleArray(),
            ch.map { maxOf(it.ground, it.top ?: it.ground) }.toDoubleArray(),
            ch.map { it.obstacle }.toTypedArray(),
        )
    }
    // the tilt of the chosen AP: the profile when there is one (antenna heights), else the list
    val selTilt = los?.chart?.takeIf { it.size >= 2 }?.let { ch -> Math.toDegrees(atan((ch.last().los - ch.first().los) / maxOf(1, ch.last().d))) }
        ?: selected.tiltDeg ?: horizon?.at(selected.bearing) ?: 0.0

    val s = state
    val frame = s?.let {
        val decl = it.declination + offset
        val aim = ArMath.aim(it.r, selected.bearing, selTilt, decl)
        ArFrame(it.r, decl, fov, beacons, selected, selTilt, rings, horizon, ArMath.aligned(aim))
    }
    LaunchedEffect(frame?.aligned == true) { if (frame?.aligned == true) haptic.performHapticFeedback(HapticFeedbackType.LongPress) }

    fun alignWithSkyline() {
        val hz = horizon ?: run { note = "Profilo del terreno non disponibile (serve la rete)"; return }
        val st = state ?: return
        auto = true
        note = "Inquadra le montagne con il cielo libero e tieni fermo il telefono…"
        val r = st.r.copyOf()
        val decl = st.declination
        grab.set { fr ->
            scope.launch {
                val m = withContext(Dispatchers.Default) {
                    val rows = ArScene.detectSkyline(fr.rgb, fr.w, fr.h)
                    val observed = rows.indices.filter { rows[it] >= 0 }.map { u -> ArScene.pixelDirection(r, u.toDouble(), rows[u].toDouble(), fr.w, fr.h, fov.first, decl) }
                    ArScene.matchSkyline(observed, hz) to observed.size
                }
                auto = false
                val match = m.first
                if (match != null) {
                    offset = match.offsetDeg
                    note = "Bussola corretta di ${"%+.1f".format(java.util.Locale.ITALY, match.offsetDeg)}°: profilo delle montagne riconosciuto (scarto ${"%.1f".format(java.util.Locale.ITALY, match.costDeg)}°)"
                    haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                } else {
                    note = if (m.second < 12) "Cielo non riconosciuto: inquadra l'orizzonte con il cielo sopra, o trascina col dito" else "Profilo non riconosciuto (poco rilievo o coperto): trascina col dito per sovrapporre la linea azzurra alle montagne"
                }
            }
        }
    }

    fun takePhoto() {
        val pv = preview.value ?: return
        val st = frame ?: return
        val bg = pv.bitmap ?: return
        val size = Size(canvasSize.width.toFloat(), canvasSize.height.toFloat())
        if (size.width <= 0f) return
        val out = ImageBitmap(size.width.toInt(), size.height.toInt())
        val canvas = androidx.compose.ui.graphics.Canvas(out)
        CanvasDrawScope().draw(density, LayoutDirection.Ltr, canvas, size) {
            drawImage(bg.asImageBitmap(), dstSize = IntSize(size.width.toInt(), size.height.toInt()))
            drawArScene(st, tm, null)
            val stamp = tm.measure("${t.name} · ${"%.5f, %.5f".format(java.util.Locale.ROOT, t.fromLatitude, t.fromLongitude)} · ${java.text.SimpleDateFormat("dd/MM/yyyy HH:mm", java.util.Locale.ITALY).format(java.util.Date())}", TextStyle(color = Color.White, fontSize = 12.sp))
            drawRect(Color.Black.copy(alpha = 0.55f), Offset(0f, size.height - stamp.size.height - 12f), Size(size.width, stamp.size.height + 12f))
            drawText(stamp, topLeft = Offset(10f, size.height - stamp.size.height - 6f))
        }
        scope.launch {
            val where = withContext(Dispatchers.IO) { savePhoto(context, out.asAndroidBitmap(), selected.name) }
            note = where?.let { "Foto salvata in $it" } ?: "Foto non salvata"
        }
    }

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        CameraPreview(Modifier.fillMaxSize(), preview, grab)
        Canvas(
            Modifier.fillMaxSize()
                .pointerInput(beacons) {
                    detectTapGestures { pos -> hits.firstOrNull { it.rect.contains(pos) }?.id?.let { selectedId = it } }
                }
                .pointerInput(Unit) {
                    // drag sideways: lay the blue skyline on the real mountains (compass correction)
                    detectHorizontalDragGestures { _, dx ->
                        val f = ArMath.focalPixels(size.width.toFloat(), size.height.toFloat(), fov.first, fov.second)
                        offset -= Math.toDegrees(atan(dx / f))
                    }
                },
        ) {
            canvasSize = IntSize(size.width.toInt(), size.height.toInt())
            hits.clear()
            frame?.let { drawArScene(it, tm, hits) }
        }

        val shadow = Modifier.clip(RoundedCornerShape(10.dp)).background(Color.Black.copy(alpha = 0.55f)).padding(horizontal = 10.dp, vertical = 6.dp)
        Column(Modifier.align(Alignment.BottomStart).fillMaxWidth().padding(10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            if (liveSignal) {
                val fs by c.field.state.collectAsState()
                val sig = fs.status?.signal
                val v = FieldDiagnosis.signalVerdict(sig, c.field.thresholds)
                Text(
                    sig?.let { "Segnale CPE $it dBm" + (fs.peak?.let { p -> " · picco $p" } ?: "") } ?: if (fs.status?.associated == false) "CPE non agganciata" else "Lettura del segnale della CPE…",
                    color = when (v) { Verdict.Ok -> Ok; Verdict.Warn -> Warn; else -> Bad },
                    fontSize = 24.sp,
                    fontWeight = FontWeight.Bold,
                    modifier = shadow,
                )
            }
            Column(shadow) {
                val l = los
                val verdict = when (l?.verdict) {
                    "clear" -> "Linea libera" to Ok
                    "fresnel" -> "Fresnel invasa" to Warn
                    "blocked" -> (if (l.buildings) "Ostruita da edifici" else "Ostruita dal terreno") to Bad
                    else -> null
                }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(selected.name, color = Color.White, fontWeight = FontWeight.Bold, fontSize = 18.sp)
                    verdict?.let { (txt, col) -> Text(txt, color = col, fontWeight = FontWeight.SemiBold) }
                }
                val aim = s?.let { ArMath.aim(it.r, selected.bearing, selTilt, it.declination + offset) }
                Text(
                    listOfNotNull(
                        "${selected.bearing.roundToInt()}°",
                        "tilt ${"%+.1f".format(java.util.Locale.ITALY, selTilt)}°",
                        selected.distanceM?.let { km(it) },
                        selected.signalDbm?.let { "atteso $it dBm" },
                    ).joinToString(" · "),
                    color = Color.White,
                    style = MaterialTheme.typography.bodySmall,
                )
                if (aim != null) Text(
                    if (frame?.aligned == true) "Allineato" else listOfNotNull(
                        aim.yawOffset.takeIf { abs(it) > 2 }?.let { if (it > 0) "gira a destra ${it.roundToInt()}°" else "gira a sinistra ${(-it).roundToInt()}°" },
                        aim.pitchOffset.takeIf { abs(it) > 2 }?.let { if (it > 0) "alza ${it.roundToInt()}°" else "abbassa ${(-it).roundToInt()}°" },
                    ).joinToString(" · "),
                    color = if (frame?.aligned == true) Ok else Color.White,
                    fontWeight = FontWeight.Bold,
                )
                rings.firstOrNull { it.invaded }?.let { Text("Il ${it.obstacle} entra nella zona di Fresnel a ${km(it.distanceM)}: guarda dentro gli anelli", color = Bad, style = MaterialTheme.typography.bodySmall) }
                if (rings.isNotEmpty()) Text("Anelli vicini: tieni liberi alberi e tetti dentro il cerchio", color = Color.White.copy(alpha = 0.8f), style = MaterialTheme.typography.bodySmall)
            }
            if (s != null && s.accuracy <= 1) {
                Text("Bussola non calibrata: muovi il telefono disegnando un 8", color = Color.White, modifier = Modifier.background(Color(0xCCB42318)).padding(6.dp))
            }
            note?.let { Text(it, color = Color.White, style = MaterialTheme.typography.bodySmall, modifier = shadow) }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilledTonalButton(onClick = { alignWithSkyline() }, enabled = !auto && horizon != null) { Text(if (auto) "Riconosco…" else "Allinea sulle montagne") }
                if (offset != 0.0) TextButton(onClick = { offset = 0.0; note = "Correzione azzerata" }) { Text("Azzera ${"%+.1f".format(java.util.Locale.ITALY, offset)}°", color = Color.White) }
                FilledTonalButton(onClick = { takePhoto() }) { Text("Foto") }
            }
        }
    }
}

/** Back camera live preview (CameraX) and frames on request for the skyline, bound to the screen's lifecycle. */
@Composable
private fun CameraPreview(modifier: Modifier, view: androidx.compose.runtime.MutableState<PreviewView?>, grab: AtomicReference<((Frame) -> Unit)?>) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    val previewView = remember { PreviewView(context).apply { scaleType = PreviewView.ScaleType.FILL_CENTER; implementationMode = PreviewView.ImplementationMode.COMPATIBLE } }
    DisposableEffect(owner) {
        view.value = previewView
        val future = ProcessCameraProvider.getInstance(context)
        val worker = Executors.newSingleThreadExecutor()
        var provider: ProcessCameraProvider? = null
        future.addListener({
            provider = future.get().also { p ->
                val preview = Preview.Builder().build().also { it.setSurfaceProvider(previewView.surfaceProvider) }
                val analysis = ImageAnalysis.Builder()
                    .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_RGBA_8888)
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .build()
                analysis.setAnalyzer(worker) { img ->
                    try {
                        grab.getAndSet(null)?.invoke(img.toPortraitRgb())
                    } finally {
                        img.close()
                    }
                }
                p.unbindAll()
                runCatching { p.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis) }
                    .onFailure { runCatching { p.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, preview) } }
            }
        }, ContextCompat.getMainExecutor(context))
        onDispose {
            provider?.unbindAll()
            worker.shutdown()
            view.value = null
        }
    }
    AndroidView(factory = { previewView }, modifier = modifier)
}

/**
 * Augmented reality straight away, without an installation or a chosen AP: the GPS of the phone,
 * the APs around from the server (the ones of this account for installers), the best one chosen.
 */
@Composable
fun ArLiveScreen(c: AppContainer) {
    val context = LocalContext.current
    var ready by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var attempt by remember { mutableStateOf(0) }
    LaunchedEffect(attempt) {
        error = null
        val here = runCatching { it.cdanet.cpeconfigurator.network.LocationHelper(context).current() }.getOrElse { error = "Posizione non disponibile: ${it.message}"; return@LaunchedEffect }
        val d = runCatching { c.api.pointing(here.latitude, here.longitude, null) }.getOrElse { error = it.message; return@LaunchedEffect }
        val best = d.aps.firstOrNull() ?: run { error = if (d.restricted && d.assignedCount == 0) "Nessun AP assegnato al tuo account" else "Nessun AP entro ${d.maxKm} km da qui"; return@LaunchedEffect }
        c.compassTarget.value = it.cdanet.cpeconfigurator.field.CompassTarget(
            name = best.name.ifBlank { best.id },
            bearing = best.bearing,
            distanceM = best.distanceM,
            fromLatitude = d.from.lat,
            fromLongitude = d.from.lon,
            tiltDeg = best.tiltDeg,
            altitude = best.altitude,
            fromAltitude = d.from.altitude,
            apId = best.id,
            heightM = d.from.height,
            beacons = d.aps.map { it.toBeacon() },
        )
        ready = true
    }
    if (ready) return ArAimScreen(c)
    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        if (error == null) Text("Cerco la posizione e gli AP intorno…")
        else {
            Text(error!!, color = MaterialTheme.colorScheme.error)
            FilledTonalButton(onClick = { attempt++ }) { Text("Riprova") }
        }
    }
}
