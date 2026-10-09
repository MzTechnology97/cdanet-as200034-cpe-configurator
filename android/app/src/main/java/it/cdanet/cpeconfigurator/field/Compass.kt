package it.cdanet.cpeconfigurator.field

import android.content.Context
import android.hardware.GeomagneticField
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

/** AP to point at (bearing from the server, true north) seen from the CPE position (used for the declination). */
data class CompassTarget(
    val name: String,
    val bearing: Int,
    val distanceM: Int?,
    val fromLatitude: Double,
    val fromLongitude: Double,
    /** Elevation angle towards the AP (terrain + antenna heights), degrees; null = unknown. */
    val tiltDeg: Double? = null,
    /** AP antenna and installation point altitude, metres a.s.l. */
    val altitude: Double? = null,
    val fromAltitude: Double? = null,
)

enum class CompassQuality { Good, Fair, Poor }

data class CompassReading(
    /** Heading of the phone's top edge, true north (declination applied). */
    val heading: Double,
    val declination: Double,
    /** Android sensor status (0 unreliable … 3 high). */
    val sensorAccuracy: Int,
    /** Heading accuracy estimated by the fused sensor, degrees (when the device reports it). */
    val headingAccuracyDeg: Double?,
    val fieldMicroTesla: Double?,
    val expectedMicroTesla: Double?,
    /** Phone tilt from horizontal, degrees. */
    val tiltDeg: Double,
)

/** Pure compass logic (unit-tested): turn direction, calibration and magnetic interference checks. */
object CompassMath {
    // SensorManager.SENSOR_STATUS_ACCURACY_* (kept here so the logic is testable on the JVM)
    const val ACCURACY_LOW = 1
    const val ACCURACY_MEDIUM = 2

    fun normalize(deg: Double): Double = ((deg % 360) + 360) % 360

    /** Signed turn from [heading] to [target], -180..180 (positive = turn right / clockwise). */
    fun delta(heading: Double, target: Double): Double {
        val d = normalize(target - heading)
        return if (d > 180) d - 360 else d
    }

    fun turnAdvice(delta: Double): String = when {
        abs(delta) <= 3 -> "Allineato"
        delta > 0 -> "Gira di ${delta.roundToInt()}° a destra"
        else -> "Gira di ${(-delta).roundToInt()}° a sinistra"
    }

    /** |measured − expected| field strength: metal nearby (mast, bracket, railing) distorts the reading. */
    fun interference(measured: Double?, expected: Double?): Double? =
        if (measured == null || expected == null) null else abs(measured - expected)

    fun quality(r: CompassReading): CompassQuality {
        val disturbance = interference(r.fieldMicroTesla, r.expectedMicroTesla)
        return when {
            r.sensorAccuracy <= ACCURACY_LOW -> CompassQuality.Poor
            disturbance != null && disturbance > 15 -> CompassQuality.Poor
            (r.headingAccuracyDeg ?: 0.0) > 20 -> CompassQuality.Poor
            r.tiltDeg > 30 -> CompassQuality.Fair
            r.sensorAccuracy == ACCURACY_MEDIUM -> CompassQuality.Fair
            disturbance != null && disturbance > 8 -> CompassQuality.Fair
            (r.headingAccuracyDeg ?: 0.0) > 10 -> CompassQuality.Fair
            else -> CompassQuality.Good
        }
    }

    /** Italian, actionable warnings for the technician. */
    fun warnings(r: CompassReading): List<String> = buildList {
        if (r.sensorAccuracy <= ACCURACY_LOW) {
            add("Bussola non calibrata: muovi il telefono disegnando un 8 nell'aria per qualche secondo")
        } else if (r.sensorAccuracy == ACCURACY_MEDIUM) {
            add("Calibrazione media: per più precisione muovi il telefono disegnando un 8")
        }
        r.headingAccuracyDeg?.takeIf { it > 10 }?.let { add("Precisione stimata ±${it.roundToInt()}°") }
        interference(r.fieldMicroTesla, r.expectedMicroTesla)?.takeIf { it > 8 }?.let {
            add("Disturbo magnetico (${r.fieldMicroTesla?.roundToInt()} µT invece di ~${r.expectedMicroTesla?.roundToInt()} µT): allontanati da palo, staffa, ringhiere, auto o quadri elettrici")
        }
        if (r.tiltDeg > 30) add("Tieni il telefono in piano (orizzontale)")
    }
}

/**
 * Fused heading (rotation vector) corrected to true north, plus the raw magnetic field to
 * detect metal nearby. The sensor's calibration status is reported, never assumed.
 */
class CompassSensor(context: Context) : SensorEventListener {
    private val sm = context.getSystemService(SensorManager::class.java)
    private val rotation: Sensor? = sm.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)
    private val magnetic: Sensor? = sm.getDefaultSensor(Sensor.TYPE_MAGNETIC_FIELD)
    private val _reading = MutableStateFlow<CompassReading?>(null)
    val reading: StateFlow<CompassReading?> = _reading.asStateFlow()
    val available: Boolean get() = rotation != null && magnetic != null

    private var geo: GeomagneticField? = null
    private var accuracy = SensorManager.SENSOR_STATUS_UNRELIABLE
    private var field: Double? = null
    private var sinAvg = 0.0
    private var cosAvg = 1.0
    private var primed = false
    private val r = FloatArray(9)
    private val orientation = FloatArray(3)

    fun start(latitude: Double, longitude: Double) {
        geo = GeomagneticField(latitude.toFloat(), longitude.toFloat(), 0f, System.currentTimeMillis())
        primed = false
        rotation?.let { sm.registerListener(this, it, SensorManager.SENSOR_DELAY_UI) }
        magnetic?.let { sm.registerListener(this, it, SensorManager.SENSOR_DELAY_UI) }
    }

    fun stop() = sm.unregisterListener(this)

    override fun onAccuracyChanged(sensor: Sensor, acc: Int) {
        if (sensor.type == Sensor.TYPE_MAGNETIC_FIELD) accuracy = acc
    }

    override fun onSensorChanged(e: SensorEvent) {
        when (e.sensor.type) {
            Sensor.TYPE_MAGNETIC_FIELD -> {
                field = sqrt((e.values[0] * e.values[0] + e.values[1] * e.values[1] + e.values[2] * e.values[2]).toDouble())
                accuracy = e.accuracy
            }
            Sensor.TYPE_ROTATION_VECTOR -> {
                SensorManager.getRotationMatrixFromVector(r, e.values)
                SensorManager.getOrientation(r, orientation)
                val g = geo
                val declination = g?.declination?.toDouble() ?: 0.0
                val az = Math.toRadians(CompassMath.normalize(Math.toDegrees(orientation[0].toDouble()) + declination))
                // Low-pass on the unit circle (no jump at 359° → 0°).
                if (!primed) { sinAvg = sin(az); cosAvg = cos(az); primed = true } else {
                    sinAvg = 0.8 * sinAvg + 0.2 * sin(az)
                    cosAvg = 0.8 * cosAvg + 0.2 * cos(az)
                }
                val tilt = Math.toDegrees(maxOf(abs(orientation[1].toDouble()), abs(orientation[2].toDouble())))
                val headingAcc = if (e.values.size >= 5 && e.values[4] >= 0) Math.toDegrees(e.values[4].toDouble()) else null
                _reading.value = CompassReading(
                    heading = CompassMath.normalize(Math.toDegrees(atan2(sinAvg, cosAvg))),
                    declination = declination,
                    sensorAccuracy = accuracy,
                    headingAccuracyDeg = headingAcc,
                    fieldMicroTesla = field,
                    expectedMicroTesla = g?.fieldStrength?.let { it / 1000.0 },
                    tiltDeg = tilt,
                )
            }
        }
    }
}
