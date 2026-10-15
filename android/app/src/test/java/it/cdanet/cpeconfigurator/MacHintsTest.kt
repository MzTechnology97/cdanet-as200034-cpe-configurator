package it.cdanet.cpeconfigurator

import it.cdanet.cpeconfigurator.tools.pro.MacHints
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MacHintsTest {
    @Test
    fun normalize() {
        assertEquals("24:A4:3C:11:22:33", MacHints.normalize("24a43c112233"))
        assertEquals("24:A4:3C:11:22:33", MacHints.normalize("24-A4-3C-11-22-33"))
        assertNull("multicast", MacHints.normalize("01:00:5E:00:00:FB"))
        assertNull(MacHints.normalize("00:00:00:00:00:00"))
        assertNull("mixed separators", MacHints.normalize("24:A4-3C:11:22:33"))
        assertNull(MacHints.normalize("SN123456"))
    }

    @Test
    fun privateMacs() {
        assertTrue(MacHints.isPrivate("DA:A1:19:00:00:01"))
        assertTrue(MacHints.isPrivate("02:00:00:00:00:01"))
        assertFalse(MacHints.isPrivate("24:A4:3C:11:22:33"))
    }

    @Test
    fun eui64() {
        assertEquals("24:A4:3C:11:22:33", MacHints.fromEui64("fe80::26a4:3cff:fe11:2233%wlan0"))
        assertEquals("24:A4:3C:11:22:33", MacHints.fromEui64("FE80:0:0:0:26A4:3CFF:FE11:2233"))
        assertNull("privacy address", MacHints.fromEui64("fe80::9c3e:1a2b:4c5d:6e7f"))
        assertNull("not link-local", MacHints.fromEui64("2001:db8::26a4:3cff:fe11:2233"))
    }

    @Test
    fun mdns() {
        assertEquals("AA:BB:CC:00:11:22", MacHints.fromMdns(mapOf("deviceid" to "AA:BB:CC:00:11:22"), emptyList(), emptyList()))
        assertEquals("24:A4:3C:11:22:33", MacHints.fromMdns(emptyMap(), listOf("24A43C112233@Soggiorno._raop._tcp.local"), emptyList()))
        assertEquals("24:A4:3C:11:22:33", MacHints.fromMdns(emptyMap(), listOf("Stampante._ipp._tcp.local"), listOf("fe80::26a4:3cff:fe11:2233")))
        assertNull(MacHints.fromMdns(mapOf("md" to "Chromecast"), listOf("Chromecast._googlecast._tcp.local"), emptyList()))
    }

    @Test
    fun upnp() {
        assertEquals("24:A4:3C:11:22:33", MacHints.fromUpnp(mapOf("serialNumber" to "24A43C112233")))
        assertEquals("94:9F:3E:11:22:33", MacHints.fromUpnp(mapOf("UDN" to "uuid:RINCON_949F3E11223301400")))
        assertEquals("C8:0E:14:11:22:33", MacHints.fromUpnp(mapOf("UDN" to "uuid:75802409-bccb-40e7-8e6c-c80e14112233")))
        assertNull("a random UUID tail", MacHints.fromUpnp(mapOf("UDN" to "uuid:75802409-bccb-40e7-8e6c-3a7f9b2c4d5e")))
    }
}
