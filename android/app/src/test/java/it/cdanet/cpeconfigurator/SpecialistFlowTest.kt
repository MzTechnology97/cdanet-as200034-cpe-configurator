package it.cdanet.cpeconfigurator

import it.cdanet.cpeconfigurator.data.AppJson
import it.cdanet.cpeconfigurator.data.CredentialsDto
import it.cdanet.cpeconfigurator.data.DetectedDto
import it.cdanet.cpeconfigurator.data.SpecAcceptanceDto
import it.cdanet.cpeconfigurator.data.SpecAskedDto
import it.cdanet.cpeconfigurator.data.SpecCpeLoginDto
import it.cdanet.cpeconfigurator.data.SpecJobDto
import it.cdanet.cpeconfigurator.data.SpecJobRequest
import it.cdanet.cpeconfigurator.data.SpecRadioDto
import it.cdanet.cpeconfigurator.data.SpecResultDto
import it.cdanet.cpeconfigurator.data.SpecTemplateDto
import it.cdanet.cpeconfigurator.firmware.AirosImage
import it.cdanet.cpeconfigurator.specialist.SpecCpe
import it.cdanet.cpeconfigurator.specialist.SpecForm
import it.cdanet.cpeconfigurator.specialist.SpecialistRules
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The Specialist's flow (owner, 17/10/2026): what it asks before writing, what goes to the server. */
class SpecialistFlowTest {
    private val cpe = SpecCpe(
        ip = "192.168.1.20", sshPort = 22, model = "LiteBeam 5AC", product = "LBE-5AC-Gen2", mac = "24:A4:3C:11:22:33",
        macs = listOf("24:A4:3C:11:22:33"), serial = "24A43C112233", firmware = "WA.ipq40xx.v8.7.4.45112.210415.1103",
        build = AirosImage.parseBuild("WA.ipq40xx.v8.7.4.45112.210415.1103"), board = "LiteBeam 5AC Gen2", hostname = null, factory = true,
        login = CredentialsDto("ubnt", "ubnt"), loginLabel = "credenziali di fabbrica",
    )
    private val template = SpecTemplateDto(id = 4, model = "LiteBeam 5AC", name = "Azienda X")
    private val asked = listOf(
        SpecAskedDto("SSID", "SSID dell'AP"),
        SpecAskedDto("WPA2_PSK", "Chiave Wi-Fi (WPA2) dell'AP", secret = true),
        SpecAskedDto("PPPOE_USER", "Utente PPPoE"),
        SpecAskedDto("VLAN_ID", "VLAN_ID", own = true),
    )
    private val ready = SpecForm(
        templateId = 4,
        values = mapOf("SSID" to "AZIENDA-X-AP3", "WPA2_PSK" to "chiave-del-mio-ap", "PPPOE_USER" to "rossi@x.it", "VLAN_ID" to "87"),
        cpeUser = "admin-x",
        cpePassword = "Una-Password-1",
    )

    @Test
    fun `ready to prepare, and what stops it`() {
        assertEquals(emptyList<String>(), SpecialistRules.problems(ready, cpe, template, asked, firmwareReady = true))
        val missing = SpecialistRules.problems(ready.copy(values = ready.values - "VLAN_ID", cpePassword = "ubnt"), cpe, template, asked, firmwareReady = false)
        assertTrue(missing.toString(), missing.any { it.startsWith("Manca: VLAN_ID") })
        assertTrue(missing.toString(), missing.any { it.contains("fabbrica") })
        assertTrue(missing.toString(), missing.any { it.startsWith("Firmware") })
        val shortKey = SpecialistRules.problems(ready.copy(values = ready.values + ("WPA2_PSK" to "corta")), cpe, template, asked, true)
        assertTrue(shortKey.toString(), shortKey.any { it.startsWith("Chiave Wi-Fi") })
        val other = SpecialistRules.problems(ready, cpe, template.copy(model = "NanoBeam 5AC"), asked, true)
        assertTrue(other.toString(), other.any { it.contains("NanoBeam 5AC") })
        assertTrue(SpecialistRules.problems(ready, null, template, asked, true).contains("Leggi prima la CPE collegata"))
    }

    @Test
    fun `the firmware, the MAC written for, the values kept for the next CPE`() {
        assertTrue(SpecialistRules.firmwareReady(cpe, "8.7.4", keep = false))
        assertFalse(SpecialistRules.firmwareReady(cpe, "8.7.11", keep = false))
        assertTrue(SpecialistRules.firmwareReady(cpe, "8.7.11", keep = true))
        // the discovery's MAC when the CPE reports it, else the first one read
        assertEquals("24a43c112235", SpecialistRules.macFor("24:A4:3C:11:22:35", setOf("24a43c112233", "24a43c112235")))
        assertEquals("24a43c112233", SpecialistRules.macFor("00:11:22:33:44:55", setOf("24a43c112233")))
        val next = SpecialistRules.keepForNext(ready.values + ("RADIUS_KEY" to "x"), asked)
        assertEquals(mapOf("SSID" to "AZIENDA-X-AP3", "VLAN_ID" to "87"), next)
        assertTrue(SpecialistRules.isWpa2Key("12345678") && SpecialistRules.isWpa2Key("A".repeat(64)) && !SpecialistRules.isWpa2Key("1234567"))
        assertFalse(SpecialistRules.isSsid("x".repeat(33)))
    }

    @Test
    fun `the requests carry the server's keys only, without nulls`() {
        val req = SpecJobRequest(templateId = 4, model = "LiteBeam 5AC", mac = "24:A4:3C:11:22:33", cpe = SpecCpeLoginDto("admin-x", "p"), values = mapOf("SSID" to "AP"))
        val keys = AppJson.encodeToJsonElement(SpecJobRequest.serializer(), req).jsonObject.keys
        assertEquals(setOf("templateId", "model", "mac", "cpe", "values"), keys)
        val result = AppJson.encodeToJsonElement(SpecResultDto.serializer(), SpecResultDto("success", listOf("ok"), detected = DetectedDto(firmware = "8.7.4"))).jsonObject.keys
        assertEquals(setOf("result", "stages", "error", "detected"), result)
        val acc = AppJson.encodeToJsonElement(SpecAcceptanceDto.serializer(), SpecAcceptanceDto(verdict = "ok", radio = SpecRadioDto(signal = -58))).jsonObject
        assertEquals(setOf("verdict", "radio"), acc.keys)
        assertEquals(setOf("signal"), acc["radio"]!!.jsonObject.keys)
        assertFalse(req.toString().contains("\"p\""))
    }

    @Test
    fun `an installation as the server sends it`() {
        val j = AppJson.decodeFromString(
            SpecJobDto.serializer(),
            """{"id":"6f1c","createdAt":"2026-10-17T10:00:00.000Z","completedAt":null,"status":"success","attempts":1,"model":"LiteBeam 5AC","template":"Azienda X","templateId":4,
               "mac":"24:A4:3C:11:22:33","serial":"","firmware":"","deviceName":"ROSSI","ssid":"AP3","pppoeUser":"rossi","customer":"","notes":"","company":"Azienda X",
               "connector":{"id":2,"name":"Azienda X"},"location":{"lat":37.5,"lon":14.1,"source":"gps"},"stages":["ok"],"detected":{"firmware":"8.7.4"},"error":"",
               "acceptance":{"verdict":"warn","radio":{"signal":-66},"at":"2026-10-17T10:30:00.000Z"},
               "uisp":{"deviceId":null,"siteId":null,"site":"","authorizedAt":null,"error":""}}""",
        )
        assertTrue(j.toAuthorize)
        assertEquals("ROSSI", j.title)
        assertEquals("warn", j.acceptance?.verdict)
        assertEquals(-66, j.acceptance?.radio?.signal)
    }
}
