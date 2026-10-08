package it.cdanet.cpeconfigurator

import it.cdanet.cpeconfigurator.field.CompassMath
import it.cdanet.cpeconfigurator.field.CompassQuality
import it.cdanet.cpeconfigurator.field.CompassReading
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CompassTest {
    private fun reading(acc: Int = 3, field: Double? = 44.0, expected: Double? = 44.5, tilt: Double = 5.0, headingAcc: Double? = 4.0) =
        CompassReading(heading = 10.0, declination = 3.5, sensorAccuracy = acc, headingAccuracyDeg = headingAcc, fieldMicroTesla = field, expectedMicroTesla = expected, tiltDeg = tilt)

    @Test
    fun turnDirectionAcrossNorth() {
        assertEquals(20.0, CompassMath.delta(350.0, 10.0), 0.001)
        assertEquals(-20.0, CompassMath.delta(10.0, 350.0), 0.001)
        assertEquals(180.0, kotlin.math.abs(CompassMath.delta(0.0, 180.0)), 0.001)
        assertEquals("Allineato", CompassMath.turnAdvice(2.0))
        assertEquals("Gira di 45° a destra", CompassMath.turnAdvice(45.0))
        assertEquals("Gira di 30° a sinistra", CompassMath.turnAdvice(-30.0))
        assertEquals(359.0, CompassMath.normalize(-1.0), 0.001)
    }

    @Test
    fun calibrationAndInterferenceAreChecked() {
        assertEquals(CompassQuality.Good, CompassMath.quality(reading()))
        // not calibrated
        assertEquals(CompassQuality.Poor, CompassMath.quality(reading(acc = 1)))
        assertTrue(CompassMath.warnings(reading(acc = 0)).first().contains("disegnando un 8"))
        // metal nearby: 70 µT where ~44 µT are expected
        assertEquals(CompassQuality.Poor, CompassMath.quality(reading(field = 70.0)))
        assertTrue(CompassMath.warnings(reading(field = 70.0)).any { it.contains("Disturbo magnetico") })
        // phone not flat, medium calibration
        assertEquals(CompassQuality.Fair, CompassMath.quality(reading(tilt = 45.0)))
        assertEquals(CompassQuality.Fair, CompassMath.quality(reading(acc = 2)))
        assertEquals(CompassQuality.Poor, CompassMath.quality(reading(headingAcc = 35.0)))
    }
}
