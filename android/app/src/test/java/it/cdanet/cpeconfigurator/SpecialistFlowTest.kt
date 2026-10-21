package it.cdanet.cpeconfigurator

import it.cdanet.cpeconfigurator.data.AfterApplyDto
import it.cdanet.cpeconfigurator.data.AppJson
import it.cdanet.cpeconfigurator.data.ChecksDto
import it.cdanet.cpeconfigurator.data.ConfigDto
import it.cdanet.cpeconfigurator.data.CpeIdDto
import it.cdanet.cpeconfigurator.data.CredentialsDto
import it.cdanet.cpeconfigurator.data.DetectedDto
import it.cdanet.cpeconfigurator.data.JobSummaryDto
import it.cdanet.cpeconfigurator.data.ProvisionPackage
import it.cdanet.cpeconfigurator.data.SpecAcceptanceDto
import it.cdanet.cpeconfigurator.data.SpecAskedDto
import it.cdanet.cpeconfigurator.data.SpecCpeLoginDto
import it.cdanet.cpeconfigurator.data.SpecJobDto
import it.cdanet.cpeconfigurator.data.SpecJobRequest
import it.cdanet.cpeconfigurator.data.SpecRadioDto
import it.cdanet.cpeconfigurator.data.SpecResultDto
import it.cdanet.cpeconfigurator.data.Session
import it.cdanet.cpeconfigurator.data.SessionState
import it.cdanet.cpeconfigurator.data.SpecTemplateDto
import it.cdanet.cpeconfigurator.data.TargetDto
import it.cdanet.cpeconfigurator.data.UserDto
import it.cdanet.cpeconfigurator.firmware.AirosImage
import it.cdanet.cpeconfigurator.specialist.SpecCpe
import it.cdanet.cpeconfigurator.specialist.SpecForm
import it.cdanet.cpeconfigurator.specialist.SpecialistRules
import it.cdanet.cpeconfigurator.ui.screens.shortcutCatalog
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
        // first the configuration, then the CPE (owner, 17/10/2026): no CPE read yet is fine, its firmware is seen at the write
        assertEquals(emptyList<String>(), SpecialistRules.problems(ready, null, template, asked, firmwareReady = false))
        val fromCpe = SpecialistRules.problems(ready, null, template, asked, true, placeholders = listOf("SSID", "EXPECTED_SERIAL"))
        assertTrue(fromCpe.toString(), fromCpe.any { it.contains("MAC o il seriale") })
        assertEquals(emptyList<String>(), SpecialistRules.problems(ready, cpe, template, asked, true, placeholders = listOf("EXPECTED_SERIAL")))
    }

    @Test
    fun `a configuration prepared before the CPE goes on the CPE read`() {
        val pkg = ProvisionPackage(
            jobId = "j1",
            expiresAt = "2026-10-17T20:00:00Z",
            target = TargetDto("192.168.1.20"),
            credentials = CredentialsDto("admin-x", "Una-Password-1"),
            checks = ChecksDto(firmware = "8.7.4", boardMatch = "board\\.name=LiteBeam", mac = "", firmwareBypass = true),
            config = ConfigDto(text = "wireless.1.ssid=AP3", sha256 = "abc"),
            summary = JobSummaryDto(model = "LiteBeam 5AC", ssid = "AP3", pppoeUser = "rossi", deviceName = "ROSSI", mac = "", serial = ""),
            afterApply = AfterApplyDto("192.168.1.1", 80, 443),
        )
        assertTrue(pkg.needsCpe)
        assertTrue(SpecialistRules.writeProblems(pkg, null, firmwareReady = true).single().startsWith("Collegati"))
        assertTrue(SpecialistRules.writeProblems(pkg, cpe.copy(model = "NanoBeam 5AC"), true).single().contains("NanoBeam 5AC"))
        assertTrue(SpecialistRules.writeProblems(pkg, cpe, firmwareReady = false).single().startsWith("Firmware"))
        assertEquals(emptyList<String>(), SpecialistRules.writeProblems(pkg, cpe, true))
        val bound = SpecialistRules.bind(pkg, cpe.copy(ip = "192.168.1.36", sshPort = 2222))
        assertEquals(TargetDto("192.168.1.36", 2222), bound.target)
        assertEquals("24:A4:3C:11:22:33", bound.checks.mac)
        assertEquals("24:A4:3C:11:22:33", bound.summary.mac)
        assertEquals("24A43C112233", bound.summary.serial)
        assertTrue(bound.scannedOnSite)
        assertFalse(bound.needsCpe)
        assertEquals(pkg.config, bound.config)
        // prepared with the CPE read: nothing to wait for
        assertEquals(emptyList<String>(), SpecialistRules.writeProblems(bound, null, firmwareReady = false))
        // the outcome tells the server which CPE was written
        val r = AppJson.encodeToJsonElement(SpecResultDto.serializer(), SpecResultDto("success", cpe = CpeIdDto("24:A4:3C:11:22:33", "24A43C112233"))).jsonObject
        assertEquals(setOf("mac", "serial"), r["cpe"]!!.jsonObject.keys)
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
        // before connecting to the CPE: no MAC, no address
        val first = AppJson.encodeToJsonElement(SpecJobRequest.serializer(), req.copy(mac = null)).jsonObject.keys
        assertEquals(setOf("templateId", "model", "cpe", "values"), first)
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
        val prepared = AppJson.decodeFromString(SpecJobDto.serializer(), """{"id":"7a2d","status":"prepared","model":"LiteBeam 5AC","mac":"","cpeAtWrite":true}""")
        assertEquals("LiteBeam 5AC", prepared.title)
        assertEquals("MAC letto alla scrittura", prepared.macLabel)
        assertEquals("24:A4:3C:11:22:33", j.macLabel)
        // written with UISP off: never «da autorizzare»
        val off = AppJson.decodeFromString(SpecJobDto.serializer(), """{"id":"8b3e","status":"success","connector":{"id":2,"name":"Azienda X"},"uisp":{"off":true}}""")
        assertTrue(off.uisp.off)
        assertFalse(off.toAuthorize)
    }

    // owner, 18/10/2026: in bridge no PPPoE is asked (the server leaves it out), the company's UISP
    // key may stay empty and then the CPE is written with UISP off
    @Test
    fun `the company's UISP key is optional, and an empty one means UISP off`() {
        val withKey = asked + SpecAskedDto("UISP_ENROLLMENT", "Chiave UISP dell'azienda", secret = true, optional = true)
        assertEquals(emptyList<String>(), SpecialistRules.problems(ready, cpe, template, withKey, true))
        val bad = SpecialistRules.problems(ready.copy(values = ready.values + ("UISP_ENROLLMENT" to "chiave")), cpe, template, withKey, true)
        assertTrue(bad.toString(), bad.any { it.startsWith("Chiave UISP") })
        val good = ready.copy(values = ready.values + ("UISP_ENROLLMENT" to "wss://uisp.azienda-x.it:443+chiave+allowSelfSignedCertificate"))
        assertEquals(emptyList<String>(), SpecialistRules.problems(good, cpe, template, withKey, true))
        // the other values are still needed
        val missing = SpecialistRules.problems(ready.copy(values = ready.values - "SSID"), cpe, template, withKey, true)
        assertTrue(missing.toString(), missing.any { it == "Manca: SSID dell'AP" })
        val dto = AppJson.decodeFromString(SpecAskedDto.serializer(), """{"name":"UISP_ENROLLMENT","label":"Chiave UISP dell'azienda","secret":true,"own":false,"optional":true}""")
        assertTrue(dto.optional)
        assertFalse(AppJson.decodeFromString(SpecAskedDto.serializer(), """{"name":"SSID"}""").optional)
        assertTrue(SpecialistRules.uispOff("netmode=bridge\nunms.uri=\nunms.status=disabled\n"))
        assertFalse(SpecialistRules.uispOff("unms.uri=wss://x\nunms.status=enabled\n"))
        assertTrue(SpecialistRules.isUispKey("WSS://uisp.x:443+k") && !SpecialistRules.isUispKey("wss://a b"))
    }

    // issue #275: a specialist may be outside CDA Net. Without «visibilità piena» he sees his own work
    // and his groups' (no team agenda on Oggi), never CDA Net's installations and keys
    @Test
    fun `a specialist sees his own and his groups', CDA Net only with full view`() {
        val session = Session()
        fun as_(user: UserDto) = session.set(SessionState("t", user, "2099-01-01T00:00:00Z"))
        as_(UserDto(5, "spec.a", "specialist"))
        assertTrue(session.isSpecialist)
        assertFalse("no team agenda, no NOC views", session.seesAll)
        assertFalse("no CDA Net installation", session.doesCdaWork)
        as_(UserDto(5, "spec.a", "specialist", fullView = true))
        assertTrue(session.seesAll && session.doesCdaWork)
        as_(UserDto(7, "tecnico", "installer"))
        assertFalse(session.seesAll)
        assertTrue(session.doesCdaWork)
        as_(UserDto(1, "cda", "admin"))
        assertTrue(session.seesAll && session.doesCdaWork)
        // the login as the server sends it: fullView only when an admin gave it
        assertTrue(AppJson.decodeFromString(UserDto.serializer(), """{"id":5,"username":"spec.a","role":"specialist","fullView":true}""").fullView)
        assertFalse(AppJson.decodeFromString(UserDto.serializer(), """{"id":5,"username":"spec.a","role":"specialist"}""").fullView)
        // a template of another member: its author's, with its secrets
        val shared = AppJson.decodeFromString(
            SpecTemplateDto.serializer(),
            """{"id":9,"model":"LiteBeam 5AC","name":"Azienda X","authorId":6,"author":"spec.b","mine":false,"secretsSet":{"snmpCommunity":true,"wpa2Psk":true}}""",
        )
        assertFalse(shared.mine)
        assertEquals("spec.b", shared.author)
        // the Wi-Fi key of the AP kept in the template (v1.36.4): only that it is there
        assertTrue(shared.secretsSet.wpa2Psk && shared.secretsSet.snmpCommunity)
        assertFalse("an older server", template.secretsSet.wpa2Psk)
        assertTrue("an older server: his own", template.mine)
        // Oggi: his flow, none of CDA Net's CPE tools and installations
        val ids = shortcutCatalog(emptyMap(), admin = false, offline = false, specialist = true, cdaWork = false).map { it.id }
        assertTrue(ids.toString(), ids.containsAll(listOf("spec_new", "spec_history", "spec_templates")))
        assertFalse(ids.toString(), ids.any { it in setOf("cpe", "alignment", "diagnosis", "visible_aps", "acceptance", "firmware", "todo", "history", "cpe_health") })
        assertTrue(shortcutCatalog(emptyMap(), admin = false, offline = false, specialist = true).any { it.id == "cpe" })
    }
}
