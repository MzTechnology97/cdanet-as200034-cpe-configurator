package it.cdanet.cpeconfigurator

import it.cdanet.cpeconfigurator.data.AdvisorCpeDto
import it.cdanet.cpeconfigurator.data.AdvisorDto
import it.cdanet.cpeconfigurator.data.AdvisorFindingDto
import it.cdanet.cpeconfigurator.data.AppJson
import it.cdanet.cpeconfigurator.data.OptimizerDto
import it.cdanet.cpeconfigurator.ui.screens.adviceGroups
import it.cdanet.cpeconfigurator.ui.screens.optimizable
import it.cdanet.cpeconfigurator.ui.screens.optimizerOutcome
import it.cdanet.cpeconfigurator.ui.screens.networkTabTitles
import it.cdanet.cpeconfigurator.ui.screens.shortcutCatalog
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AdvisorTest {
    private fun f(id: String, ap: String, severity: String, cpe: String? = null, dismissed: Boolean = false) =
        AdvisorFindingDto(id = id, severity = severity, apId = ap, apName = "AP-$ap", cpe = cpe?.let { AdvisorCpeDto(id = it, name = "Cliente $it") }, dismissedUntil = if (dismissed) "2099-01-01T00:00:00Z" else null)

    @Test
    fun onlyAdminsSeeIaAp() {
        assertTrue("IA-AP" in networkTabTitles(emptyMap(), admin = true))
        assertFalse("IA-AP" in networkTabTitles(emptyMap(), admin = false))
        assertTrue(shortcutCatalog(emptyMap(), admin = true, offline = false).any { it.id == "ia_ap" })
        assertFalse(shortcutCatalog(emptyMap(), admin = false, offline = false).any { it.id == "ia_ap" })
    }

    @Test
    fun groupsByApWithTheApFindingsFirst() {
        val all = listOf(f("1", "a", "critico", cpe = "x"), f("2", "b", "attenzione"), f("3", "a", "attenzione"), f("4", "a", "info", cpe = "y", dismissed = true))
        val g = adviceGroups(all, "", "", showDismissed = false)
        assertEquals(listOf("AP-a", "AP-b"), g.map { it.first })
        assertEquals(listOf("3", "1"), g[0].second.map { it.id })
        assertEquals(listOf("1"), adviceGroups(all, "critico", "", false).flatMap { it.second }.map { it.id })
        assertEquals(listOf("4"), adviceGroups(all, "", "cliente y", true).flatMap { it.second }.map { it.id })
        assertTrue(adviceGroups(all, "", "cliente y", false).isEmpty())
    }

    @Test
    fun readsTheServerAnswer() {
        val json = """{"at":"2026-10-10T20:00:00Z","range":{"from":5120,"to":5800},"loadAt":null,"findings":[{"id":"channel:ap-1","severity":"info","kind":"channel","apId":"ap-1","apName":"N1","title":"Canale più libero","detail":"…","action":"…","params":{"frequenza":5415,"ampiezza":40},"since":"2026-10-09T10:00:00Z","dismissedUntil":null}]}"""
        val d = AppJson.decodeFromString(AdvisorDto.serializer(), json)
        assertEquals(5800, d.range.to)
        assertEquals("5415", d.findings[0].params!!["frequenza"].toString())
    }

    @Test
    fun optimizeOnlyApFindingsAChannelCanFix() {
        val ap = f("1", "a", "info").copy(kind = "channel")
        assertTrue(optimizable(ap, enabled = true))
        assertFalse(optimizable(ap, enabled = false))
        assertFalse(optimizable(ap.copy(kind = "busy"), enabled = true))
        assertFalse(optimizable(f("2", "a", "critico", cpe = "x").copy(kind = "snr"), enabled = true))
    }

    @Test
    fun readsTheOptimizerRuns() {
        val json = """{"enabled":true,"active":null,"runs":[{"id":"opt-1","apId":"ap-1","apName":"N1","mode":"suggested","findingId":"channel:ap-1","by":"admin","requestedAt":"2026-10-10T20:00:00Z","startAt":"2026-10-11T01:00:00Z","state":"completato","step":"Finito","original":{"centre":5500,"width":40,"control":5490,"ieeeMode":"11acvht40"},"changed":false,"candidates":[{"centre":5300,"width":40}],"baseline":{"stations":3,"capacityMbps":300,"medianSnrDb":32,"medianMcs":8,"weakestDbm":-70,"noiseDbm":-92},"results":[{"centre":5300,"width":40,"verdict":"migliore","capacityRatio":1.3,"missing":[],"before":{"stations":3,"capacityMbps":300},"after":{"stations":3,"capacityMbps":390,"medianSnrDb":33,"weakestDbm":-69}}],"outcome":"migliorato","kept":{"centre":5300,"width":40},"missing":[],"endedAt":"2026-10-11T01:30:00Z","error":null}]}"""
        val o = AppJson.decodeFromString(OptimizerDto.serializer(), json)
        assertEquals(5300, o.runs[0].kept!!.centre)
        assertEquals("canale migliore tenuto", optimizerOutcome(o.runs[0]).first)
    }
}
