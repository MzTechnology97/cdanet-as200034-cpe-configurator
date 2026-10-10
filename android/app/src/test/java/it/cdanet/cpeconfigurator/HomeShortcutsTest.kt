package it.cdanet.cpeconfigurator

import it.cdanet.cpeconfigurator.ui.Screen
import it.cdanet.cpeconfigurator.ui.screens.DEFAULT_SHORTCUTS
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
    fun moves() {
        val ids = listOf("a", "b", "c")
        assertEquals(listOf("b", "a", "c"), moveShortcut(ids, "b", -1))
        assertEquals(listOf("a", "c", "b"), moveShortcut(ids, "b", 1))
        assertEquals(ids, moveShortcut(ids, "a", -1))
        assertEquals(ids, moveShortcut(ids, "c", 1))
        assertEquals(ids, moveShortcut(ids, "x", 1))
    }
}
