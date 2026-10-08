package it.cdanet.cpeconfigurator

import it.cdanet.cpeconfigurator.data.ChecksDto
import it.cdanet.cpeconfigurator.data.Settings
import it.cdanet.cpeconfigurator.network.Ip
import it.cdanet.cpeconfigurator.provisioning.DeviceCheck
import it.cdanet.cpeconfigurator.provisioning.ProvisionForm
import it.cdanet.cpeconfigurator.provisioning.Validation
import it.cdanet.cpeconfigurator.routeros.RouterOsPolicy
import it.cdanet.cpeconfigurator.tools.Snmp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceCheckTest {
    private val readback = """
        __VERSION__
        XC.qca956x.v8.7.4.45112.210415.1103
        __BOARD__
        board.sysid=0xe7f5
        board.name=LiteBeam 5AC
        board.shortname=LBE-5AC-Gen2
        board.hwaddr=24A43C112233
        __SYSTEM__
        eth0.macaddr=24:A4:3C:11:22:33
    """.trimIndent()

    private val checks = ChecksDto(firmware = "8.7.4", boardMatch = "board\\.name=LiteBeam 5AC", mac = "24:A4:3C:11:22:33")

    @Test fun parsesReadback() {
        val rb = DeviceCheck.parse(readback)
        assertEquals("XC.qca956x.v8.7.4.45112.210415.1103", rb.firmware)
        assertEquals("LiteBeam 5AC", rb.board)
        assertEquals(setOf("24a43c112233"), rb.macs)
        assertEquals("24:A4:3C:11:22:33", rb.detected().mac)
    }

    @Test fun acceptsExpectedDevice() {
        DeviceCheck.verify(DeviceCheck.parse(readback), checks)
    }

    @Test fun rejectsOtherFirmwareBoardOrMac() {
        val rb = DeviceCheck.parse(readback)
        assertThrows(IllegalStateException::class.java) { DeviceCheck.verify(DeviceCheck.parse(readback.replace("v8.7.4.", "v8.7.11.")), checks) }
        assertThrows(IllegalStateException::class.java) { DeviceCheck.verify(rb, checks.copy(boardMatch = "board\\.name=PowerBeam")) }
        assertThrows(IllegalStateException::class.java) { DeviceCheck.verify(rb, checks.copy(mac = "AA:BB:CC:DD:EE:FF")) }
        assertThrows(IllegalStateException::class.java) { DeviceCheck.verify(rb, checks.copy(boardMatch = "")) }
    }

    @Test fun firmwareMatchIsExact() {
        assertTrue(DeviceCheck.firmwareMatches("XC.qca956x.v8.7.4.45112.210415.1103", "8.7.4"))
        assertTrue(DeviceCheck.firmwareMatches("WA.ar934x.v8.7.4", "8.7.4"))
        assertFalse(DeviceCheck.firmwareMatches("XC.qca956x.v8.7.41.1", "8.7.4"))
        assertFalse(DeviceCheck.firmwareMatches("XC.qca956x.v18.7.4.1", "8.7.4"))
        assertFalse(DeviceCheck.firmwareMatches(null, "8.7.4"))
    }

    @Test fun hashes() {
        assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", DeviceCheck.sha256Hex(ByteArray(0)))
        assertEquals("d41d8cd98f00b204e9800998ecf8427e", DeviceCheck.md5Hex(ByteArray(0)))
    }
}

class ValidationTest {
    @Test fun normalizesMacAndScan() {
        assertEquals("24:A4:3C:11:22:33", Validation.normalizeMac("24a43c112233"))
        assertEquals("24:A4:3C:11:22:33", Validation.normalizeMac("24-a4-3c-11-22-33"))
        val f = Validation.applyScan(ProvisionForm(), "24A43C112233")
        assertEquals("24:A4:3C:11:22:33", f.mac)
        assertEquals("24A43C112233", f.serial)
        assertEquals("SN-XYZ", Validation.applyScan(f, "SN-XYZ").serial)
    }

    @Test fun derivesSsidAndCustomer() {
        val f = ProvisionForm(node = 7, district = 3, pppoeUser = "rossi.mario@cda-net.it")
        assertEquals("CDA-NET-N7-D03", f.ssid)
        assertEquals("ROSSI MARIO", f.customerName)
        assertEquals(3, f.errors().size)
        val ok = f.copy(mac = "24a43c112233", serial = "S", pppoePassword = "x")
        assertTrue(ok.errors().isEmpty())
        assertEquals("24:A4:3C:11:22:33", ok.toRequest().mac)
    }
}

class RouterOsPolicyTest {
    @Test fun readonlyTerminal() {
        assertEquals("/interface print", RouterOsPolicy.readonlyCommand(" /interface print "))
        assertThrows(IllegalArgumentException::class.java) { RouterOsPolicy.readonlyCommand("/ip address add address=1.1.1.1/32") }
        assertThrows(IllegalArgumentException::class.java) { RouterOsPolicy.readonlyCommand("/interface print; /system reboot") }
        assertThrows(IllegalArgumentException::class.java) { RouterOsPolicy.readonlyCommand("/system identity") }
    }

    @Test fun redactsSecrets() {
        val out = RouterOsPolicy.redact("password=Secret1 name=x wpa2-pre-shared-key=\"a b\" secret: zz")
        assertFalse(out.contains("Secret1"))
        assertFalse(out.contains("a b"))
        assertFalse(out.contains("zz"))
    }

    @Test fun summarizes() {
        val s = RouterOsPolicy.summarize("  name: Core", " version: 7.15 (stable)\n board-name: hAP", "model: RB951")
        assertEquals("Core", s["Identity"])
        assertEquals("7.15 (stable)", s["RouterOS"])
        assertEquals("hAP", s["Board"])
    }
}

class NetTest {
    @Test fun privateRanges() {
        assertTrue(Ip.isPrivate("192.168.172.1"))
        assertTrue(Ip.isPrivate("100.64.0.1"))
        assertTrue(Ip.isPrivate("172.31.0.29"))
        assertFalse(Ip.isPrivate("172.32.0.1"))
        assertFalse(Ip.isPrivate("8.8.8.8"))
    }

    @Test fun scanCidr() {
        val c = Ip.parseScanCidr("192.168.1.77/24")
        assertEquals("192.168.1.0/24", c.toString())
        assertEquals("192.168.1.1", Ip.format(c.first))
        assertEquals("192.168.1.254", Ip.format(c.last))
        assertThrows(IllegalArgumentException::class.java) { Ip.parseScanCidr("10.0.0.0/16") }
        assertThrows(IllegalArgumentException::class.java) { Ip.parseScanCidr("8.8.8.0/24") }
    }

    @Test fun backendUrlPolicy() {
        assertEquals("http://172.31.0.29", Settings.normalizeBackendUrl("http://172.31.0.29/"))
        assertEquals("https://cpe.example.it", Settings.normalizeBackendUrl("https://cpe.example.it"))
        assertThrows(IllegalArgumentException::class.java) { Settings.normalizeBackendUrl("http://cpe.example.it") }
    }

    @Test fun snmpRoundTrip() {
        val oid = "1.3.6.1.2.1.1.5.0"
        assertEquals(oid, Snmp.decodeOid(Snmp.encodeOid(oid)))
        assertEquals("1.3.6.1.4.1.41112.1.4", Snmp.decodeOid(Snmp.encodeOid("1.3.6.1.4.1.41112.1.4")))
        val vb = Snmp.tlv(0x30, Snmp.tlv(0x06, Snmp.encodeOid(oid)) + Snmp.tlv(0x04, "cpe".toByteArray()))
        val pdu = Snmp.tlv(0xa2, Snmp.tlv(0x02, byteArrayOf(0x10, 0x92.toByte())) + Snmp.tlv(0x02, byteArrayOf(0)) + Snmp.tlv(0x02, byteArrayOf(0)) + Snmp.tlv(0x30, vb))
        val msg = Snmp.tlv(0x30, Snmp.tlv(0x02, byteArrayOf(1)) + Snmp.tlv(0x04, "public".toByteArray()) + pdu)
        val r = Snmp.parse(msg)
        assertEquals(4242, r.requestId)
        assertEquals("cpe", r.values[oid])
        val req = Snmp.getRequest("public", listOf(oid), 4242)
        assertEquals(0x30, req[0].toInt())
    }
}
