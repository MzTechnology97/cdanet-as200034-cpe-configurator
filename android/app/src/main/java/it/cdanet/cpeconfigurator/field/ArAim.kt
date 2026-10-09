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
import kotlin.math.asin
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt

/** Where the target is as seen by the back camera (portrait screen). */
data class AimView(
    /** Degrees to turn right (+) or left (−) to center the target. */
    val yawOffset: Double,
    /** Degrees to tilt up (+) or down (−). */
    val pitchOffset: Double,
    /** Target direction in screen coordinates (x right, y up) and along the camera axis (> 0 = in front). */
    val x: Double,
    val y: Double,
    val forward: Double,
    /** Camera axis: azimuth (true north) and elevation above the horizon, degrees. */
    val cameraAzimuth: Double,
    val cameraElevation: Double,
)

/**
 * Pure camera-aiming math (unit-tested on the JVM). [r] is Android's 3×3 rotation matrix
 * (device → world, world = East, North, Up, magnetic north); the back camera looks along −Z.
 */
object ArMath {
    /** World unit vector towards a target at [bearingDeg] (true north) and [tiltDeg], in the magnetic frame. */
    fun targetWorld(bearingDeg: Double, tiltDeg: Double, declination: Double): DoubleArray {
        val b = Math.toRadians(bearingDeg - declination)
        val t = Math.toRadians(tiltDeg)
        return doubleArrayOf(cos(t) * sin(b), cos(t) * cos(b), sin(t))
    }

    fun aim(r: FloatArray, bearingDeg: Double, tiltDeg: Double, declination: Double): AimView {
        val w = targetWorld(bearingDeg, tiltDeg, declination)
        // device = Rᵀ · world
        val dx = r[0] * w[0] + r[3] * w[1] + r[6] * w[2]
        val dy = r[1] * w[0] + r[4] * w[1] + r[7] * w[2]
        val dz = r[2] * w[0] + r[5] * w[1] + r[8] * w[2]
        val forward = -dz
        val camAz = CompassMath.normalize(Math.toDegrees(atan2(-r[2].toDouble(), -r[5].toDouble())) + declination)
        val camEl = Math.toDegrees(asin((-r[8].toDouble()).coerceIn(-1.0, 1.0)))
        return AimView(
            yawOffset = Math.toDegrees(atan2(dx, forward)),
            pitchOffset = Math.toDegrees(atan2(dy, sqrt(forward * forward + dx * dx))),
            x = dx,
            y = dy,
            forward = forward,
            cameraAzimuth = camAz,
            cameraElevation = camEl,
        )
    }

    /** Pixels per unit of tangent for a preview that fills [w]×[h] (center crop) with the given lens field of view. */
    fun focalPixels(w: Float, h: Float, fovLongDeg: Double, fovShortDeg: Double): Double {
        val byHeight = h / (2 * kotlin.math.tan(Math.toRadians(fovLongDeg) / 2))
        val byWidth = w / (2 * kotlin.math.tan(Math.toRadians(fovShortDeg) / 2))
        return maxOf(byHeight, byWidth)
    }

    fun aligned(v: AimView, toleranceDeg: Double = 2.0) = v.forward > 0 && kotlin.math.abs(v.yawOffset) <= toleranceDeg && kotlin.math.abs(v.pitchOffset) <= toleranceDeg
}

/** Smoothed rotation matrix from the rotation-vector sensor, with the magnetometer calibration status. */
class ArOrientation(context: Context) : SensorEventListener {
    private val sm = context.getSystemService(SensorManager::class.java)
    private val rotation: Sensor? = sm.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)
    private val magnetic: Sensor? = sm.getDefaultSensor(Sensor.TYPE_MAGNETIC_FIELD)
    val available: Boolean get() = rotation != null

    data class State(val r: FloatArray, val declination: Double, val accuracy: Int)

    private val _state = MutableStateFlow<State?>(null)
    val state: StateFlow<State?> = _state.asStateFlow()
    private val raw = FloatArray(9)
    private val smooth = FloatArray(9)
    private var primed = false
    private var declination = 0.0
    private var accuracy = SensorManager.SENSOR_STATUS_UNRELIABLE

    fun start(latitude: Double, longitude: Double) {
        declination = GeomagneticField(latitude.toFloat(), longitude.toFloat(), 0f, System.currentTimeMillis()).declination.toDouble()
        primed = false
        rotation?.let { sm.registerListener(this, it, SensorManager.SENSOR_DELAY_GAME) }
        magnetic?.let { sm.registerListener(this, it, SensorManager.SENSOR_DELAY_UI) }
    }

    fun stop() = sm.unregisterListener(this)

    override fun onAccuracyChanged(sensor: Sensor, acc: Int) {
        if (sensor.type == Sensor.TYPE_MAGNETIC_FIELD) accuracy = acc
    }

    override fun onSensorChanged(e: SensorEvent) {
        if (e.sensor.type == Sensor.TYPE_MAGNETIC_FIELD) {
            accuracy = e.accuracy
            return
        }
        SensorManager.getRotationMatrixFromVector(raw, e.values)
        if (!primed) {
            raw.copyInto(smooth)
            primed = true
        } else {
            for (i in 0 until 9) smooth[i] = 0.75f * smooth[i] + 0.25f * raw[i]
        }
        _state.value = State(smooth.copyOf(), declination, accuracy)
    }
}
