package it.cdanet.cpeconfigurator

import it.cdanet.cpeconfigurator.ui.localTime
import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Test

class LocalTimeTest {
    private val rome = ZoneId.of("Europe/Rome")

    @Test
    fun utcInstantsAreShownInTheLocalZone() {
        assertEquals("15/10/26 00:06", localTime("2026-10-14T22:06:31.512Z", rome))
        assertEquals("15/01/26 10:00", localTime("2026-01-15T09:00:00Z", rome))
    }

    @Test
    fun timesWithoutZoneAndMissingOnesStayAsTheyAre() {
        assertEquals("2026-10-14 22:06", localTime("2026-10-14T22:06:00", rome))
        assertEquals("", localTime(null, rome))
    }
}
