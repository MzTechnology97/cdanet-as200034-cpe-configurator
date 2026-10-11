package it.cdanet.cpeconfigurator.field

import kotlin.math.abs
import kotlin.math.asin
import kotlin.math.atan
import kotlin.math.atan2
import kotlin.math.max
import kotlin.math.sqrt

/**
 * Augmented reality of the coverage check (pure math, unit-tested on the JVM): the APs around as
 * beacons, the skyline of the terrain model over the camera, the Fresnel zone towards the chosen
 * AP as a tunnel of rings, and the compass corrected by matching the real skyline of the camera
 * with the one of the terrain (as a peak finder does).
 */

/** An AP seen from the point: direction, elevation (null: unknown, put on the skyline) and estimate. */
data class ArBeacon(
    val id: String?,
    val name: String,
    val bearing: Double,
    val tiltDeg: Double? = null,
    val distanceM: Int? = null,
    val signalDbm: Int? = null,
    /** buono, possibile, improbabile, non attivo, senza stima (null: from the signal). */
    val rating: String? = null,
)

/** Skyline of the terrain: elevation angle every [stepDeg] from true north (server /api/pointing/horizon). */
class ArHorizon(val stepDeg: Double, val el: DoubleArray, val dist: IntArray) {
    /** Elevation of the skyline at true azimuth [az], linear between samples. */
    fun at(az: Double): Double {
        val n = el.size
        val x = CompassMath.normalize(az) / stepDeg
        val i = x.toInt() % n
        val f = x - kotlin.math.floor(x)
        return el[i] * (1 - f) + el[(i + 1) % n] * f
    }

    fun distanceAt(az: Double): Int = dist[(CompassMath.normalize(az) / stepDeg).roundToIntSafe() % dist.size]

    private fun Double.roundToIntSafe() = kotlin.math.round(this).toInt()
}

/** One ring of the Fresnel tunnel: [distanceM] from the CPE, angular radius and whether something enters it. */
data class FresnelRing(val distanceM: Int, val radiusDeg: Double, val invaded: Boolean, val obstacle: String?)

object ArScene {
    /**
     * Rings of 60% of the first Fresnel zone at a few distances along the link, from the profile
     * of the server ([d], [los], [fresnel60] = lower edge of the zone, [top] = ground or what stands
     * on it). Seen from the CPE the tube is a tunnel: wide near (trees, roofs), narrow far.
     */
    fun fresnelRings(d: IntArray, los: DoubleArray, fresnel60: DoubleArray, top: DoubleArray, kind: Array<String?>): List<FresnelRing> {
        if (d.size < 2) return emptyList()
        val total = d.last()
        val wanted = intArrayOf(10, 25, 50, 100, 200, 400, 800, 1500, 3000, 6000, 12000)
        return wanted.filter { it < total * 0.92 }.mapNotNull { w ->
            // the profile point nearest to the wanted distance (and the worst around it)
            var k = 0
            for (i in d.indices) if (abs(d[i] - w) < abs(d[k] - w)) k = i
            if (d[k] <= 0) return@mapNotNull null
            val r = los[k] - fresnel60[k]
            val lo = max(1, k - 1)
            val hi = minOf(d.size - 2, k + 1)
            var hit = false
            var what: String? = null
            for (i in lo..hi) if (top[i] > fresnel60[i]) {
                hit = true
                what = kind[i] ?: "terreno"
            }
            FresnelRing(d[k], Math.toDegrees(atan(r / d[k])), hit, what)
        }
    }

    /**
     * Direction (true azimuth, elevation) of a pixel of a portrait camera frame [w]×[h] whose long
     * side spans [fovLongDeg], for the rotation matrix [r] (device → world, magnetic) and [declination].
     */
    fun pixelDirection(r: FloatArray, u: Double, v: Double, w: Int, h: Int, fovLongDeg: Double, declination: Double): Pair<Double, Double> {
        val f = h / (2 * kotlin.math.tan(Math.toRadians(fovLongDeg) / 2))
        val dx = (u - w / 2.0) / f
        val dy = -(v - h / 2.0) / f
        val dz = -1.0
        // world = R · device
        val wx = r[0] * dx + r[1] * dy + r[2] * dz
        val wy = r[3] * dx + r[4] * dy + r[5] * dz
        val wz = r[6] * dx + r[7] * dy + r[8] * dz
        val n = sqrt(wx * wx + wy * wy + wz * wz)
        val az = CompassMath.normalize(Math.toDegrees(atan2(wx, wy)) + declination)
        val el = Math.toDegrees(asin((wz / n).coerceIn(-1.0, 1.0)))
        return az to el
    }

    /**
     * The real skyline in a portrait frame of [w]×[h] RGB pixels ([rgb]: 0xRRGGBB): for every
     * column, the first row from the top where the sky ends (−1: no clear sky above). Sky: bright,
     * not warmer than blue, and close to the sky colour of the top rows; the edge must hold for a
     * few rows (wires, birds, a branch do not end the sky).
     */
    fun detectSkyline(rgb: IntArray, w: Int, h: Int): IntArray {
        fun lum(p: Int) = 0.299 * (p shr 16 and 255) + 0.587 * (p shr 8 and 255) + 0.114 * (p and 255)
        // sky colour: the brightest half of the top band
        val top = (0 until w).flatMap { x -> (0 until max(1, h / 20)).map { y -> rgb[y * w + x] } }.sortedBy { lum(it) }
        val ref = top.drop(top.size / 2)
        if (ref.isEmpty()) return IntArray(w) { -1 }
        val refL = ref.map { lum(it) }.average()
        val refR = ref.map { (it shr 16 and 255).toDouble() }.average()
        val refG = ref.map { (it shr 8 and 255).toDouble() }.average()
        val refB = ref.map { (it and 255).toDouble() }.average()
        if (refL < 90) return IntArray(w) { -1 } // night, indoors, a wall: no sky to match
        fun sky(p: Int): Boolean {
            val r = (p shr 16 and 255).toDouble()
            val g = (p shr 8 and 255).toDouble()
            val b = (p and 255).toDouble()
            val dist = sqrt((r - refR) * (r - refR) + (g - refG) * (g - refG) + (b - refB) * (b - refB))
            return lum(p) > refL * 0.72 && b >= r - 18 && dist < 70
        }
        val out = IntArray(w) { -1 }
        val hold = max(3, h / 60)
        for (x in 0 until w) {
            if (!sky(rgb[x])) continue
            var y = 0
            while (y < h) {
                if (!sky(rgb[y * w + x])) {
                    var solid = true
                    for (k in 1..hold) if (y + k < h && sky(rgb[(y + k) * w + x])) solid = false
                    if (solid) break
                }
                y++
            }
            if (y in (h / 30) until (h * 95 / 100)) out[x] = y
        }
        return out
    }

    /**
     * Compass error from the skyline: the offset (degrees, true = measured + offset) that best lays
     * the camera skyline ([observed]: measured azimuth to elevation) on the terrain one, within
     * ±[rangeDeg]. Null when the camera skyline is too short or does not match anywhere well.
     */
    fun matchSkyline(observed: List<Pair<Double, Double>>, horizon: ArHorizon, rangeDeg: Double = 20.0, stepDeg: Double = 0.2): SkylineMatch? {
        if (observed.size < 12) return null
        // the vertical position is trusted (gravity): only the azimuth slides
        val costs = ArrayList<Pair<Double, Double>>()
        var off = -rangeDeg
        while (off <= rangeDeg + 1e-9) {
            val errs = observed.map { (az, el) -> abs(el - horizon.at(az + off)) }.sorted()
            // robust: the best 70% (trees and roofs above the terrain skyline are expected)
            costs += off to errs.take(max(6, errs.size * 7 / 10)).average()
            off += stepDeg
        }
        val (bestOff, bestCost) = costs.minBy { it.second }
        val second = costs.filter { abs(it.first - bestOff) > 2 }.minOfOrNull { it.second } ?: Double.MAX_VALUE
        val best: SkylineMatch? = SkylineMatch(bestOff, bestCost, 0.0)
        val b = best ?: return null
        // relief of the terrain skyline in the frame: a flat horizon cannot fix the azimuth
        val els = observed.map { horizon.at(it.first + b.offsetDeg) }
        val relief = els.max() - els.min()
        val distinct = if (second == Double.MAX_VALUE) 1.0 else (second - b.costDeg) / max(0.05, second)
        return if (b.costDeg <= 0.6 && relief >= 0.6 && distinct >= 0.15) b.copy(distinctness = distinct) else null
    }
}

data class SkylineMatch(val offsetDeg: Double, val costDeg: Double, val distinctness: Double)
