package it.cdanet.cpeconfigurator

import it.cdanet.cpeconfigurator.ui.Screen
import it.cdanet.cpeconfigurator.ui.screens.DEFAULT_SHORTCUTS
import it.cdanet.cpeconfigurator.ui.screens.hubTabTitles
import it.cdanet.cpeconfigurator.ui.screens.moveShortcut
import it.cdanet.cpeconfigurator.ui.screens.resolveShortcuts
import it.cdanet.cpeconfigurator.ui.screens.shortcutCatalog
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HomeShortcutsTest {
    private val all = emptyMap<String, Boolean>()

    @Test
    fun defaultsWhenNeverCustomised() {
        val shown = resolveShortcuts(null, shortcutCatalog(all, admin = false, offline = false))
        assertEquals(DEFAULT_SHORTCUTS, shown.map { it.id })
    }

    @Test
    fun accountChoiceKeepsItsOrder() {
        val shown = resolveShortcuts(listOf("history", "lan", "coverage", "lan"), shortcutCatalog(all, admin = false, offline = false))
        assertEquals(listOf("history", "lan", "coverage"), shown.map { it.id })
        assertEquals(emptyList<String>(), resolveShortcuts(emptyList(), shortcutCatalog(all, false, false)).map { it.id })
    }

    @Test
    fun featuresTurnedOffOrUnknownAreHidden() {
        val noCoverage = shortcutCatalog(mapOf("coverage" to false, "compass" to false), admin = false, offline = false)
        assertFalse(noCoverage.any { it.id == "coverage" || it.id == "near_aps" })
        assertEquals(listOf("lan"), resolveShortcuts(listOf("coverage", "removed_feature", "lan"), noCoverage).map { it.id })
    }

    @Test
    fun withoutLoginOnlyLocalTools() {
        val offline = shortcutCatalog(all, admin = false, offline = true).map { it.id }
        assertTrue("lan" in offline && "wifi" in offline)
        assertFalse(offline.any { it in listOf("cpe", "coverage", "guide", "history", "notifications") })
    }

    @Test
    fun healthTabFollowsTheRole() {
        val admin = shortcutCatalog(all, admin = true, offline = false).first { it.id == "cpe_health" }
        val installer = shortcutCatalog(all, admin = false, offline = false).first { it.id == "cpe_health" }
        assertEquals("Salute CPE", admin.dest.tab)
        assertEquals("Stato CPE", installer.dest.tab)
        assertEquals(Screen.Installations, installer.dest.screen)
    }

    @Test
    fun idsAreUnique() {
        val ids = shortcutCatalog(all, admin = true, offline = false).map { it.id }
        assertEquals(ids.size, ids.toSet().size)
        assertTrue(DEFAULT_SHORTCUTS.all { it in ids })
    }

    @Test
    fun everyShortcutLandsOnARealTab() {
        for (admin in listOf(true, false)) {
            for (s in shortcutCatalog(all, admin, offline = false)) {
                val tab = s.dest.tab ?: continue
                assertTrue("${s.id} → ${s.dest.screen}/$tab", tab in hubTabTitles(s.dest.screen, all, admin))
            }
        }
    }

    @Test
    fun everyToolHasAShortcut() {
        // every entry of Strumenti and every tab of the customer's-network tools
        val ids = shortcutCatalog(all, admin = false, offline = false).map { it.id }
        val tools = listOf("cpe", "lan", "lan_discovery", "ports", "wifi", "net_diag", "net_diag_adv", "devices", "snmp", "cameras", "routeros", "remote", "guide")
        assertEquals(emptyList<String>(), tools - ids.toSet())
        assertTrue("search" in ids && "settings" in ids)
        // without login: the local tools and Impostazioni, Scansione LAN first among them
        val offline = shortcutCatalog(all, admin = false, offline = true).map { it.id }
        assertEquals(listOf("lan", "lan_discovery", "ports", "wifi", "net_diag", "net_diag_adv", "devices", "snmp", "cameras", "routeros", "remote", "settings"), offline)
    }

    @Test
    fun moves() {
        val ids = listOf("a", "b", "c")
        assertEquals(listOf("b", "a", "c"), moveShortcut(ids, "b", -1))
        assertEquals(listOf("a", "c", "b"), moveShortcut(ids, "b", 1))
        assertEquals(ids, moveShortcut(ids, "a", -1))
        assertEquals(ids, moveShortcut(ids, "c", 1))
        assertEquals(ids, moveShortcut(ids, "x", 1))
    }
}
