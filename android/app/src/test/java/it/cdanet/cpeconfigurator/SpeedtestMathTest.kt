package it.cdanet.cpeconfigurator

import it.cdanet.cpeconfigurator.tools.speedtest.SpeedTarget
import it.cdanet.cpeconfigurator.tools.speedtest.SpeedtestConfig
import it.cdanet.cpeconfigurator.tools.speedtest.SpeedtestMath
import it.cdanet.cpeconfigurator.tools.wifi.WifiAp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SpeedtestMathTest {
    private val cfg = SpeedtestConfig()

    @Test
    fun signalThresholds() {
        assertEquals(SpeedtestMath.Signal.Ok, SpeedtestMath.signal(-55, cfg))
        assertEquals(SpeedtestMath.Signal.Weak, SpeedtestMath.signal(-68, cfg))
        assertEquals(SpeedtestMath.Signal.TooWeak, SpeedtestMath.signal(-75, cfg))
        assertEquals(SpeedtestMath.Signal.Ok, SpeedtestMath.signal(null, cfg))
    }

    @Test
    fun passedAtEightyPercent() {
        val t = SpeedTarget("CDA-NET-HOME-30-6", 30.0, 6.0, 80)
        assertTrue(SpeedtestMath.passed(24.0, 4.8, t)!!)
        assertFalse(SpeedtestMath.passed(23.9, 6.0, t)!!)
        assertFalse(SpeedtestMath.passed(30.0, null, t)!!)
        assertNull("no plan known: no comparison", SpeedtestMath.passed(5.0, 1.0, null))
    }

    private fun ap(bssid: String, ssid: String, freq: Int, rssi: Int, width: Int = 20, center: Int = freq) =
        WifiAp(bssid, ssid, freq, center, width, rssi, "WPA2", "")

    @Test
    fun routerSnapshot() {
        val aps = listOf(
            ap("AA:BB:CC:00:00:01", "Casa", 2437, -50),
            ap("AA:BB:CC:00:00:02", "Casa_5G", 5180, -55, 80, 5210),
            ap("11:22:33:00:00:01", "Vicino", 2437, -70),
            ap("11:22:33:00:00:02", "Altro", 2427, -75),
            ap("11:22:33:00:00:03", "Lontano", 2462, -80),
        )
        val w = SpeedtestMath.routerWifi(aps, "aa:bb:cc:00:00:01", "Casa", 72, -50)
        assertEquals("2.4", w.band)
        assertEquals(6, w.channel)
        assertEquals(1, w.neighborsSameChannel)
        assertEquals("channel 4 overlaps channel 6", 1, w.neighborsOverlapping)
        val advice = SpeedtestMath.advice(aps, w)
        assertTrue(advice.any { "5 GHz" in it })
        // a router with no 5 GHz network: no such advice
        val only24 = aps.filter { it.ssid != "Casa_5G" }
        assertFalse(SpeedtestMath.advice(only24, SpeedtestMath.routerWifi(only24, "aa:bb:cc:00:00:01", "Casa", 72, -50)).any { "5 GHz" in it })
    }
}
