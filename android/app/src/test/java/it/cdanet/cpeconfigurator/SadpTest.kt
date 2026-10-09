package it.cdanet.cpeconfigurator

import it.cdanet.cpeconfigurator.tools.pro.Sadp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SadpTest {
    private val answer = """<?xml version="1.0" encoding="UTF-8"?><ProbeMatch><Uuid>0D7C9B0B-1111</Uuid><Types>inquiry</Types>
        <DeviceType>139863</DeviceType><DeviceDescription>DS-2CD2043G2-I</DeviceDescription><DeviceSN>DS-2CD2043G2-I20210101AAWRF12345678</DeviceSN>
        <CommandPort>8000</CommandPort><HttpPort>80</HttpPort><MAC>bc-ad-28-11-22-33</MAC><IPv4Address>192.168.1.64</IPv4Address>
        <IPv4SubnetMask>255.255.255.0</IPv4SubnetMask><IPv4Gateway>192.168.1.1</IPv4Gateway><DHCP>false</DHCP>
        <AnalogChannelNum>0</AnalogChannelNum><DigitalChannelNum>1</DigitalChannelNum><SoftwareVersion>V5.7.3build 220112</SoftwareVersion>
        <DSPVersion>V7.3 build 220112</DSPVersion><BootTime>2026-10-01 08:00:00</BootTime><Activated>false</Activated><HCPlatformEnable>true</HCPlatformEnable></ProbeMatch>"""

    @Test
    fun parsesAnswer() {
        val d = Sadp.parse(answer, "192.168.1.64")!!
        assertEquals("192.168.1.64", d.ip)
        assertEquals("BC:AD:28:11:22:33", d.mac)
        assertEquals("DS-2CD2043G2-I", d.description)
        assertEquals(80, d.httpPort)
        assertEquals(8000, d.sdkPort)
        assertEquals(false, d.activated)
        assertEquals(false, d.dhcp)
        assertEquals(true, d.hikConnect)
        assertEquals(1, d.digitalChannels)
        assertTrue(d.firmware.startsWith("V5.7.3"))
    }

    @Test
    fun ignoresOwnProbe() {
        assertNull(Sadp.parse(Sadp.probe(), "192.168.1.10"))
        assertFalse(Sadp.probe().contains("ProbeMatch"))
    }
}
