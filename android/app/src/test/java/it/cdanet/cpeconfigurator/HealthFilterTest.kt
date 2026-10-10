package it.cdanet.cpeconfigurator

import it.cdanet.cpeconfigurator.data.AssignedUserDto
import it.cdanet.cpeconfigurator.data.CpeHealthItemDto
import it.cdanet.cpeconfigurator.data.CpeNowDto
import it.cdanet.cpeconfigurator.field.HealthFilter
import it.cdanet.cpeconfigurator.field.HealthOrigin
import it.cdanet.cpeconfigurator.field.HealthProblem
import it.cdanet.cpeconfigurator.field.HealthState
import org.junit.Assert.assertEquals
import org.junit.Test

class HealthFilterTest {
    private val rossi = CpeHealthItemDto(jobId = "j1", source = "app", deviceName = "ROSSI MARIO", model = "LiteBeam 5AC", mac = "24:A4:3C:11:22:33", ssid = "CDA-NET-N2-D01", now = CpeNowDto(status = "active", apName = "AP-N2-Monte"), issues = listOf("signal_drop"), installer = "tecnico")
    private val bianchi = CpeHealthItemDto(source = "uisp", deviceName = "BIANCHI LUCA", mac = "F4:92:BF:AA:BB:CC", ssid = "CDA-NET-N3-D02", now = CpeNowDto(status = "disconnected"), issues = listOf("offline", "account_suspended"), assignedTo = AssignedUserDto(2, "altro"))
    private val verdi = CpeHealthItemDto(jobId = "j3", source = "app", deviceName = "VERDI ANNA", mac = "24:A4:3C:99:88:77", ssid = "CDA-NET-N2-D01", now = CpeNowDto(status = "active"))
    private val gone = CpeHealthItemDto(jobId = "j4", source = "app", deviceName = "NERI PAOLO", mac = "24:A4:3C:00:00:01", issues = listOf("not_in_uisp"))
    private val all = listOf(verdi, rossi, bianchi)

    private fun f(state: HealthState, problem: HealthProblem? = null, origin: HealthOrigin = HealthOrigin.All, q: String = "") = HealthFilter.apply(all, state, problem, origin, q)

    @Test
    fun stateTilesAndProblemsMostSeriousOnTop() {
        assertEquals(listOf(bianchi, rossi), f(HealthState.Issues))
        assertEquals(listOf(bianchi, rossi, verdi), f(HealthState.All))
        assertEquals(listOf(rossi, verdi), f(HealthState.Online))
        assertEquals(listOf(bianchi), f(HealthState.Offline))
        assertEquals(listOf(rossi), f(HealthState.All, HealthProblem.SignalDrop))
        assertEquals(listOf(bianchi), f(HealthState.All, HealthProblem.Suspended))
        assertEquals(emptyList<CpeHealthItemDto>(), f(HealthState.Online, HealthProblem.Suspended), "state and problem together")
    }

    @Test
    fun notFoundIsNeitherOnlineNorOffline() {
        val list = all + gone
        assertEquals(listOf(bianchi), HealthFilter.apply(list, HealthState.Offline, null, HealthOrigin.All, ""), "offline")
        assertEquals(listOf(rossi, verdi), HealthFilter.apply(list, HealthState.Online, null, HealthOrigin.All, ""), "online")
        assertEquals(listOf(bianchi, gone, rossi), HealthFilter.apply(list, HealthState.Issues, null, HealthOrigin.All, ""), "issues")
    }

    @Test
    fun searchByNameMacApSsidAndInstaller() {
        fun find(q: String) = f(HealthState.All, q = q).map { it.deviceName }
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
        assertEquals(listOf(rossi, verdi), f(HealthState.All, origin = HealthOrigin.App))
        assertEquals(listOf(bianchi), f(HealthState.All, origin = HealthOrigin.Network))
        assertEquals(listOf(bianchi), f(HealthState.All, origin = HealthOrigin.Assigned))
        assertEquals(listOf(rossi, verdi), f(HealthState.All, origin = HealthOrigin.Unassigned))
    }

    private fun assertEquals(expected: Any?, actual: Any?, message: String) = org.junit.Assert.assertEquals(message, expected, actual)
}
