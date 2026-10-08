package it.cdanet.cpeconfigurator

import it.cdanet.cpeconfigurator.field.AirosStatus
import it.cdanet.cpeconfigurator.field.FieldDiagnosis
import it.cdanet.cpeconfigurator.field.FieldThresholds
import it.cdanet.cpeconfigurator.field.Verdict
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FieldDiagnosisTest {
    private val raw = javaClass.getResource("/airos/nanobeam5ac_sta_ptmp.json")!!.readText()
    private val t = FieldThresholds()

    private fun byTitle(checks: List<it.cdanet.cpeconfigurator.field.Check>, title: String) = checks.first { it.title == title }

    @Test
    fun parsesRealAirOs8StationStatus() {
        val s = AirosStatus.parse(raw)
        assertEquals("NanoBeam-shed1", s.hostname)
        assertEquals("NanoBeam 5AC", s.model)
        assertTrue(s.associated)
        assertEquals("House-shed1", s.essid)
        assertEquals("House-Bridge", s.apName)
        assertEquals(-42, s.signal)
        assertEquals(-92, s.noise)
        assertEquals(listOf(-46, -44), s.chains)
        assertEquals(2, s.chainImbalance)
        assertEquals(-43, s.remoteSignal)
        assertEquals(-68, s.expectedSignal)
        assertEquals(34, s.cinrRx)
        assertEquals(342.0, s.dlCapacityMbps!!, 0.01)
        assertEquals(300, s.distanceM)
        assertEquals(1000, s.eth!!.speedMbps)
        assertTrue(s.eth!!.plugged)
        assertEquals(false, s.pppoeEnabled)
        assertNull(s.temperatureC) // 0 = not reported
    }

    @Test
    fun healthyLinkGivesOkChecks() {
        val checks = FieldDiagnosis.checks(AirosStatus.parse(raw), t, targetFirmware = "8.7.4")
        assertEquals(Verdict.Ok, byTitle(checks, "Segnale ricevuto").verdict)
        assertTrue(byTitle(checks, "Segnale ricevuto").detail.contains("atteso -68 dBm (+26 dB)"))
        assertEquals(Verdict.Ok, byTitle(checks, "Porta LAN (cavo)").verdict)
        assertEquals(Verdict.Ok, byTitle(checks, "Catene (polarizzazioni)").verdict)
        assertEquals(Verdict.Info, byTitle(checks, "PPPoE").verdict)
        // the sample runs 8.7.18, not the CDA Net standard
        assertEquals(Verdict.Warn, byTitle(checks, "Firmware").verdict)
        assertEquals(Verdict.Warn, FieldDiagnosis.summary(checks))
        assertFalse(FieldDiagnosis.report(AirosStatus.parse(raw), checks).contains("password", ignoreCase = true))
    }

    @Test
    fun detectsTypicalFieldFaults() {
        // Router-mode CPE with PPPoE down, not associated, damaged LAN cable.
        val root = Json.parseToJsonElement(raw).jsonObject
        val wireless = JsonObject(root["wireless"]!!.jsonObject + ("sta" to JsonArray(emptyList())))
        val ifaces = JsonArray(
            listOf(
                JsonObject(mapOf("ifname" to JsonPrimitive("eth0"), "status" to JsonObject(mapOf("plugged" to JsonPrimitive(true), "speed" to JsonPrimitive(10), "duplex" to JsonPrimitive(false))))),
                JsonObject(mapOf("ifname" to JsonPrimitive("ppp0"), "status" to JsonObject(mapOf("ipaddr" to JsonPrimitive("0.0.0.0"))))),
            ),
        )
        val services = JsonObject(root["services"]!!.jsonObject + ("pppoe" to JsonPrimitive(true)))
        val s = AirosStatus.parse(JsonObject(root + mapOf("wireless" to wireless, "interfaces" to ifaces, "services" to services)))
        val checks = FieldDiagnosis.checks(s, t, targetFirmware = null)
        assertEquals(Verdict.Bad, byTitle(checks, "Collegamento all'AP").verdict)
        assertEquals(Verdict.Warn, byTitle(checks, "Porta LAN (cavo)").verdict)
        assertTrue(byTitle(checks, "Porta LAN (cavo)").detail.contains("10 Mbit/s half"))
        assertEquals(Verdict.Bad, byTitle(checks, "PPPoE").verdict)
        assertEquals(Verdict.Bad, FieldDiagnosis.summary(checks))
        assertTrue(checks.none { it.title == "Segnale ricevuto" })
    }

    @Test
    fun signalThresholdsAndTone() {
        assertEquals(Verdict.Ok, FieldDiagnosis.signalVerdict(-60, t))
        assertEquals(Verdict.Warn, FieldDiagnosis.signalVerdict(-70, t))
        assertEquals(Verdict.Bad, FieldDiagnosis.signalVerdict(-80, t))
        assertEquals(Verdict.Bad, FieldDiagnosis.signalVerdict(null, t))
        assertTrue(FieldDiagnosis.toneHz(-50) > FieldDiagnosis.toneHz(-70))
        assertEquals(300, FieldDiagnosis.toneHz(-100))
        assertEquals(2000, FieldDiagnosis.toneHz(-30))
    }

    @Test
    fun toleratesMissingFields() {
        val s = AirosStatus.parse("""{"host":{"hostname":"x"},"wireless":{}}""")
        assertFalse(s.associated)
        assertNull(s.signal)
        assertTrue(FieldDiagnosis.checks(s, t, "8.7.4").isNotEmpty())
    }
}
