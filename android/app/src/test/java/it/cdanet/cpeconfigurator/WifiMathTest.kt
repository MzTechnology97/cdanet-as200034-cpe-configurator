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

    @Test
    fun routerAdviceIgnoresTheRouterItselfAndPicksWidth() {
        val aps = listOf(
            // the customer's box: 2.4 GHz on 3 (overlapping) and 5 GHz on 36/80 under another name
            WifiAp("11:22:33:44:55:10", "Casa", 2422, 2422, 20, -40, "WPA2", "Wi-Fi 6", connected = true),
            WifiAp("11:22:33:44:55:11", "Casa_5G", 5180, 5210, 80, -45, "WPA2", "Wi-Fi 6"),
            ap("Vicino1", 2412, -55), ap("Vicino2", 2437, -60),
            ap("Vicino5", 5180, -50, 80, 5210),
        )
        val ssids = WifiMath.routerSsids(aps, "Casa")
        assertEquals(setOf("Casa", "Casa_5G"), ssids)
        val adv = WifiMath.routerAdvice(aps, ssids).associateBy { it.band }
        val b24 = adv.getValue(WifiBand.B24)
        assertEquals(3, b24.currentChannel)
        assertEquals(11, b24.best.channel)
        assertEquals(20, b24.widthMhz)
        assertTrue(b24.move)
        val b5 = adv.getValue(WifiBand.B5)
        // 36-48 is taken by the neighbour: the free non-DFS block 149-161 at 80 MHz
        assertEquals(80, b5.widthMhz)
        assertTrue(b5.best.channel in 149..161)
        assertTrue(b5.move)
    }

    @Test
    fun routerAdviceKeepsAGoodChannel() {
        val aps = listOf(WifiAp("11:22:33:44:55:10", "Casa", 2412, 2412, 20, -40, "WPA2", "Wi-Fi 6"), ap("Lontano", 2462, -85))
        val b24 = WifiMath.routerAdvice(aps, setOf("Casa")).first { it.band == WifiBand.B24 }
        assertEquals(1, b24.currentChannel)
        assertTrue(!b24.move)
    }
}
