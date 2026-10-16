package it.cdanet.cpeconfigurator

import it.cdanet.cpeconfigurator.data.StockItemDto
import it.cdanet.cpeconfigurator.field.Verdict
import it.cdanet.cpeconfigurator.provisioning.DiscoveryCheck
import it.cdanet.cpeconfigurator.tools.UbntDevice
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DiscoveryCheckTest {
    // the discovery gives the wireless MAC (…:35), the label the LAN one (…:33)
    private val cpe = UbntDevice(
        ip = "192.168.172.1", mac = "24:A4:3C:11:22:35", hostname = "ubnt", model = "LBE-5AC-Gen2", fullModel = "LiteBeam 5AC Gen2",
        firmware = "WA.ipq40xx.v8.7.4.45112.210415.1103", ssid = null, uptimeSec = 60, version = "8.7.4", factoryDefault = true,
    )

    @Test
    fun `the CPE of the label, in the warehouse, factory and on the right firmware`() {
        val stock = listOf(StockItemDto(model = "LiteBeam 5AC", mac = "24:a4:3c:11:22:33", serial = "SN1"), StockItemDto(model = "LiteBeam 5AC", mac = "24:A4:3C:99:99:99"))
        val r = DiscoveryCheck.evaluate(cpe, "24A43C112233", stock)
        assertEquals("LiteBeam 5AC", r.model)
        assertTrue(r.checks.all { it.verdict == Verdict.Ok })
        assertEquals("SN1", r.stock?.serial)
    }

    @Test
    fun `another CPE, old firmware, already configured, the one being replaced`() {
        val old = cpe.copy(version = "8.7.11", factoryDefault = false, hostname = "ROSSI MARIO")
        val r = DiscoveryCheck.evaluate(old, "24:A4:3C:00:00:01", emptyList(), replacedMac = "24:A4:3C:11:22:33")
        val byTitle = r.checks.associateBy { it.title }
        assertEquals(Verdict.Bad, byTitle["CPE"]!!.verdict)
        assertEquals(Verdict.Bad, byTitle["MAC"]!!.verdict)
        assertEquals(Verdict.Warn, byTitle["Firmware"]!!.verdict)
        assertEquals(Verdict.Warn, byTitle["Configurazione"]!!.verdict)
        assertEquals("ROSSI MARIO", byTitle["Nome"]!!.detail)
        assertNull(r.stock)
        assertFalse(DiscoveryCheck.sameDevice(cpe, "24:A4:3C:11:22:40"))
    }
}
