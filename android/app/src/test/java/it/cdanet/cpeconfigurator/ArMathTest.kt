package it.cdanet.cpeconfigurator

import it.cdanet.cpeconfigurator.field.ArMath
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ArMathTest {
    // Phone upright in portrait, back camera looking north at the horizon:
    // device X → East, device Y → Up, device Z → South.
    private val northUpright = floatArrayOf(1f, 0f, 0f, 0f, 0f, -1f, 0f, 1f, 0f)

    @Test
    fun cameraAxis() {
        val v = ArMath.aim(northUpright, 0.0, 0.0, 0.0)
        assertEquals(0.0, v.cameraAzimuth, 0.01)
        assertEquals(0.0, v.cameraElevation, 0.01)
        assertTrue(ArMath.aligned(v))
    }

    @Test
    fun targetToTheRightAndAbove() {
        val east = ArMath.aim(northUpright, 30.0, 0.0, 0.0)
        assertEquals(30.0, east.yawOffset, 0.01)
        assertFalse(ArMath.aligned(east))
        val up = ArMath.aim(northUpright, 0.0, 10.0, 0.0)
        assertEquals(10.0, up.pitchOffset, 0.01)
        assertEquals(0.0, up.yawOffset, 0.01)
        assertTrue(up.y > 0)
    }

    @Test
    fun declinationIsApplied() {
        // magnetic north is 3° east of true north: a target at 3° true is straight ahead of a camera on magnetic 0°
        val v = ArMath.aim(northUpright, 3.0, 0.0, 3.0)
        assertEquals(0.0, v.yawOffset, 0.01)
        assertEquals(3.0, v.cameraAzimuth, 0.01)
    }

    @Test
    fun behindTheCamera() {
        val v = ArMath.aim(northUpright, 180.0, 0.0, 0.0)
        assertTrue(v.forward < 0)
        assertFalse(ArMath.aligned(v))
    }

    @Test
    fun focalLength() {
        // tall portrait view: the preview fills the height
        val f = ArMath.focalPixels(1080f, 2400f, 66.0, 52.0)
        assertEquals(2400 / (2 * Math.tan(Math.toRadians(33.0))), f, 0.5)
    }
}
