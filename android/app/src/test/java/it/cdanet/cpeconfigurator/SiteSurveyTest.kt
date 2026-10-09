package it.cdanet.cpeconfigurator

import it.cdanet.cpeconfigurator.field.SiteSurvey
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SiteSurveyTest {
    @Test
    fun parsesAirosSurvey() {
        val json = """[
            {"mac":"24:a4:3c:00:00:01","essid":"CDA-NET-N2-D01","frequency":5640,"channel":128,"signal_level":-62,"noise_level":-95,"ieee_mode":"11ACVHT80","encryption":"WPA2","airmax":1},
            {"mac":"24:a4:3c:00:00:02","essid":"Vicino","frequency":5180,"signal_level":"-80","noise_level":-96},
            {"essid":"senza mac"}
        ]"""
        val aps = SiteSurvey.parse(json)
        assertEquals(2, aps.size)
        assertEquals("24:A4:3C:00:00:01", aps[0].mac)
        assertEquals(2 to 1, aps[0].cdaNet)
        assertEquals(33, aps[0].snr)
        assertEquals(true, aps[0].airmax)
        assertEquals(36, aps[1].channel)
        assertEquals(-80, aps[1].signal)
    }

    @Test
    fun toleratesWrappersAndGarbage() {
        assertEquals(1, SiteSurvey.parse("""{"survey":[{"bssid":"AA:BB:CC:DD:EE:FF","ssid":"X","rssi":-70}]}""").size)
        assertTrue(SiteSurvey.parse("<html>login</html>").isEmpty())
    }
}
