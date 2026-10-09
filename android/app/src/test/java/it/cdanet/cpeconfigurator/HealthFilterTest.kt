package it.cdanet.cpeconfigurator

import it.cdanet.cpeconfigurator.data.AssignedUserDto
import it.cdanet.cpeconfigurator.data.CpeHealthItemDto
import it.cdanet.cpeconfigurator.data.CpeNowDto
import it.cdanet.cpeconfigurator.field.HealthFilter
import it.cdanet.cpeconfigurator.field.HealthOrigin
import it.cdanet.cpeconfigurator.field.HealthShow
import org.junit.Assert.assertEquals
import org.junit.Test

class HealthFilterTest {
    private val rossi = CpeHealthItemDto(jobId = "j1", source = "app", deviceName = "ROSSI MARIO", model = "LiteBeam 5AC", mac = "24:A4:3C:11:22:33", ssid = "CDA-NET-N2-D01", now = CpeNowDto(apName = "AP-N2-Monte"), issues = listOf("signal_drop"), installer = "tecnico")
    private val bianchi = CpeHealthItemDto(source = "uisp", deviceName = "BIANCHI LUCA", mac = "F4:92:BF:AA:BB:CC", ssid = "CDA-NET-N3-D02", issues = listOf("offline"), assignedTo = AssignedUserDto(2, "altro"))
    private val verdi = CpeHealthItemDto(jobId = "j3", source = "app", deviceName = "VERDI ANNA", mac = "24:A4:3C:99:88:77", ssid = "CDA-NET-N2-D01")
    private val all = listOf(verdi, rossi, bianchi)

    @Test
    fun problemsFirstMostSeriousOnTop() {
        assertEquals(listOf(bianchi, rossi), HealthFilter.apply(all, HealthShow.Issues, HealthOrigin.All, ""))
        assertEquals(listOf(bianchi, rossi, verdi), HealthFilter.apply(all, HealthShow.All, HealthOrigin.All, ""))
        assertEquals(listOf(rossi), HealthFilter.apply(all, HealthShow.Signal, HealthOrigin.All, ""))
        assertEquals(listOf(bianchi), HealthFilter.apply(all, HealthShow.Offline, HealthOrigin.All, ""))
    }

    @Test
    fun searchByNameMacApSsidAndInstaller() {
        fun find(q: String) = HealthFilter.apply(all, HealthShow.All, HealthOrigin.All, q).map { it.deviceName }
        assertEquals(listOf("ROSSI MARIO"), find("rossi"))
        assertEquals(listOf("ROSSI MARIO"), find("1122"))
        assertEquals(listOf("ROSSI MARIO"), find("11-22-33"))
        assertEquals(listOf("BIANCHI LUCA"), find("aabb"))
        assertEquals(listOf("ROSSI MARIO"), find("monte"))
        assertEquals(listOf("ROSSI MARIO", "VERDI ANNA"), find("n2-d01"))
        assertEquals(listOf("ROSSI MARIO"), find("n2 tecnico"))
        assertEquals(listOf("BIANCHI LUCA"), find("altro"))
        assertEquals(emptyList<String>(), find("nessuno"))
    }

    @Test
    fun originFilters() {
        assertEquals(listOf(rossi, verdi), HealthFilter.apply(all, HealthShow.All, HealthOrigin.App, ""))
        assertEquals(listOf(bianchi), HealthFilter.apply(all, HealthShow.All, HealthOrigin.Network, ""))
        assertEquals(listOf(bianchi), HealthFilter.apply(all, HealthShow.All, HealthOrigin.Assigned, ""))
        assertEquals(listOf(rossi, verdi), HealthFilter.apply(all, HealthShow.All, HealthOrigin.Unassigned, ""))
    }
}
