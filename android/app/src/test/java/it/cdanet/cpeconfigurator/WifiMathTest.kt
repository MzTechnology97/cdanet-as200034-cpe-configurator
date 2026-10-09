package it.cdanet.cpeconfigurator

import it.cdanet.cpeconfigurator.tools.wifi.WifiAp
import it.cdanet.cpeconfigurator.tools.wifi.WifiBand
import it.cdanet.cpeconfigurator.tools.wifi.WifiMath
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class WifiMathTest {
    private fun ap(ssid: String, freq: Int, rssi: Int, width: Int = 20, center: Int = freq) =
        WifiAp("AA:BB:CC:00:00:${ssid.hashCode() and 0xff}", ssid, freq, center, width, rssi, "WPA2", "Wi-Fi 6")

    @Test
    fun channelsAndBands() {
        assertEquals(1, WifiMath.channel(2412))
        assertEquals(13, WifiMath.channel(2472))
        assertEquals(36, WifiMath.channel(5180))
        assertEquals(WifiBand.B5, WifiMath.band(5500))
        assertEquals(2437, WifiMath.freqOf(WifiBand.B24, 6))
        assertEquals("Wi-Fi 6E", WifiMath.standard(6, 6115))
        assertEquals(80, WifiMath.widthMhz(2))
        assertTrue(WifiMath.isDfs(WifiBand.B5, 100))
        assertEquals("WPA2/WPA3", WifiMath.security("[WPA2-PSK-CCMP][RSN-PSK+SAE-CCMP]"))
    }

    @Test
    fun ratesBusyAndFreeChannels() {
        val aps = listOf(ap("A", 2412, -45), ap("B", 2417, -60), ap("C", 2437, -88))
        val r = WifiMath.rate(aps, WifiBand.B24).associateBy { it.channel }
        assertTrue(r.getValue(1).rating < r.getValue(11).rating)
        assertEquals(10, r.getValue(11).rating)
        assertEquals(11, WifiMath.recommend(aps, WifiBand.B24).first().channel)
    }

    @Test
    fun wideChannelsOccupyTheirWholeSpan() {
        // 80 MHz on 36-48 (center 5210): busy 36, 40, 44, 48 but not 52
        val r = WifiMath.rate(listOf(ap("W", 5180, -50, 80, 5210)), WifiBand.B5).associateBy { it.channel }
        assertTrue(r.getValue(44).networks == 1 && r.getValue(48).networks == 1)
        assertEquals(0, r.getValue(52).networks)
        assertTrue(WifiMath.recommend(listOf(ap("W", 5180, -50, 80, 5210)), WifiBand.B5).none { it.channel in 36..48 })
    }
}
