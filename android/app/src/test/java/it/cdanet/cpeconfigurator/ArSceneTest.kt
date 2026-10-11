package it.cdanet.cpeconfigurator

import it.cdanet.cpeconfigurator.field.ArHorizon
import it.cdanet.cpeconfigurator.field.ArScene
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.sin

class ArSceneTest {
    // portrait, back camera towards north at the horizon (device X → East, Y → Up, Z → South)
    private val northUpright = floatArrayOf(1f, 0f, 0f, 0f, 0f, -1f, 0f, 1f, 0f)

    /** Hills: a skyline with relief, 0.5° steps. */
    private fun hills() = ArHorizon(0.5, DoubleArray(720) { i -> 1.5 + 1.2 * sin(i * 0.5 / 7.0) + 0.6 * sin(i * 0.5 / 2.3) }, IntArray(720) { 5000 })

    @Test
    fun pixelDirectionOfTheFrame() {
        val (az, el) = ArScene.pixelDirection(northUpright, 60.0, 80.0, 120, 160, 66.0, 0.0)
        assertEquals(0.0, az, 0.01)
        assertEquals(0.0, el, 0.01)
        // top centre: up by half the long field of view
        val (_, top) = ArScene.pixelDirection(northUpright, 60.0, 0.0, 120, 160, 66.0, 0.0)
        assertEquals(33.0, top, 0.01)
        // right edge: east of north; declination turns magnetic into true
        val (right, _) = ArScene.pixelDirection(northUpright, 120.0, 80.0, 120, 160, 66.0, 3.0)
        assertTrue(right in 20.0..30.0)
    }

    @Test
    fun skylineMatchFindsTheCompassError() {
        val hz = hills()
        // the phone reads 6° less than the truth: a feature at true az is seen at az − 6
        val observed = (0 until 60).map { k ->
            val measured = 330.0 + k * 0.5
            measured to hz.at(measured + 6.0) + (if (k % 9 == 0) 2.0 else 0.0) // a few trees above the terrain
        }
        val m = ArScene.matchSkyline(observed, hz)
        assertNotNull(m)
        assertEquals(6.0, m!!.offsetDeg, 0.3)
    }

    @Test
    fun flatSkylineOrNoMatchGivesNothing() {
        val flat = ArHorizon(0.5, DoubleArray(720) { -0.2 }, IntArray(720) { 20000 })
        assertNull(ArScene.matchSkyline((0 until 40).map { (it * 0.5) to -0.2 }, flat))
        // a skyline far from the terrain one (a building filling the frame)
        assertNull(ArScene.matchSkyline((0 until 40).map { (it * 0.5) to 25.0 }, hills()))
        assertNull(ArScene.matchSkyline(listOf(1.0 to 1.0), hills()))
    }

    @Test
    fun skylineDetectedInAFrame() {
        val w = 80
        val h = 120
        val sky = 0x8EC5F0
        val ground = 0x6B5A3C
        val edge = IntArray(w) { x -> 40 + x / 4 }
        val rgb = IntArray(w * h) { i -> if (i / w < edge[i % w]) sky else ground }
        // a wire across the sky does not end it
        for (x in 0 until w) rgb[10 * w + x] = 0x202020
        val found = ArScene.detectSkyline(rgb, w, h)
        for (x in 0 until w) assertEquals(edge[x].toDouble(), found[x].toDouble(), 1.0)
        // indoors: no sky
        assertTrue(ArScene.detectSkyline(IntArray(w * h) { 0x303030 }, w, h).all { it == -1 })
    }

    @Test
    fun fresnelTunnelFromTheProfile() {
        // 3 km link, 25 m steps; a hill invading the zone around 1.5 km
        val d = IntArray(121) { it * 25 }
        val los = DoubleArray(121) { 400.0 + it * 0.5 }
        val r60 = DoubleArray(121) { i -> val x = d[i].toDouble(); 0.6 * kotlin.math.sqrt(0.0536 * x * (3000 - x) / 3000) }
        val f60 = DoubleArray(121) { los[it] - r60[it] }
        val top = DoubleArray(121) { i -> if (d[i] in 1450..1550) los[i] - 1.0 else 350.0 }
        val kind = Array<String?>(121) { null }
        val rings = ArScene.fresnelRings(d, los, f60, top, kind)
        assertTrue(rings.size >= 6)
        assertTrue(rings.first().radiusDeg > rings.last().radiusDeg)
        val near = rings.first { it.distanceM == 1500 }
        assertTrue(near.invaded)
        assertEquals("terreno", near.obstacle)
        assertFalse(rings.first { it.distanceM == 100 }.invaded)
    }
}
