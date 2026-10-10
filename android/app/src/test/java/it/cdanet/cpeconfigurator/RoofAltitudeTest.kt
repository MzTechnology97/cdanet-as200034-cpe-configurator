package it.cdanet.cpeconfigurator

import it.cdanet.cpeconfigurator.field.GpsAltitude
import it.cdanet.cpeconfigurator.field.RoofAltitude
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RoofAltitudeTest {
    private fun height(msl: Double?, acc: Double?, ground: Double?) = RoofAltitude.heightAboveGround(GpsAltitude(msl, acc), ground)

    @Test
    fun gpsAltitudeMinusTerrainGivesTheCpeHeight() {
        val r = height(512.3, 4.0, 505.0) as RoofAltitude.Result.Height
        assertEquals(7.5, r.metres, 0.0)
        assertEquals(1.0, (height(504.0, 3.0, 505.0) as RoofAltitude.Result.Height).metres, 0.5) // within the error: still a value
        assertEquals(0.5, (height(504.0, 3.0, 505.0) as RoofAltitude.Result.Height).metres, 0.0)
    }

    @Test
    fun refusesWhatCannotBeTrusted() {
        assertTrue(RoofAltitude.heightAboveGround(null, 500.0) is RoofAltitude.Result.Unusable)
        assertTrue(height(null, null, 500.0) is RoofAltitude.Result.Unusable) // older Android: ellipsoid only
        assertTrue(height(512.0, 18.0, 505.0) is RoofAltitude.Result.Unusable) // imprecise
        assertTrue(height(512.0, null, 505.0) is RoofAltitude.Result.Unusable)
        assertTrue(height(512.0, 4.0, null) is RoofAltitude.Result.Unusable) // no terrain
        assertTrue(height(480.0, 4.0, 505.0) is RoofAltitude.Result.Unusable) // below the ground
        assertTrue(height(600.0, 4.0, 505.0) is RoofAltitude.Result.Unusable) // 95 m: not a roof
    }
}
