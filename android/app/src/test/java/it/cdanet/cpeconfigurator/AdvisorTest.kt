package it.cdanet.cpeconfigurator

import it.cdanet.cpeconfigurator.data.AdvisorCpeDto
import it.cdanet.cpeconfigurator.data.AdvisorDto
import it.cdanet.cpeconfigurator.data.AdvisorFindingDto
import it.cdanet.cpeconfigurator.data.AppJson
import it.cdanet.cpeconfigurator.ui.screens.adviceGroups
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
}
