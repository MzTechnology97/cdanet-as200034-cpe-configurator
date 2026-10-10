package it.cdanet.cpeconfigurator

import it.cdanet.cpeconfigurator.ui.screens.installTabTitles
import it.cdanet.cpeconfigurator.ui.screens.networkTabTitles
import it.cdanet.cpeconfigurator.ui.screens.parseCoords
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CoverageCheckTest {
    @Test
    fun readsCoordinatesInTheUsualForms() {
        assertEquals(37.56 to 14.27, parseCoords("37.56, 14.27"))
        assertEquals(37.56 to 14.27, parseCoords("37,56 14,27"))
        assertEquals(37.56 to 14.27, parseCoords("37.56;14.27"))
        assertEquals(37.56 to 14.27, parseCoords(" 37.56 14.27 "))
        assertNull(parseCoords("Via Roma 12, Enna"))
        assertNull(parseCoords("95, 200"))
        assertNull(parseCoords("37.56"))
    }

    @Test
    fun reteKeepsOnlyTheOnSiteTool() {
        // Copertura is an area of the bottom bar: Rete keeps only the on-site AP vicini
        assertEquals(listOf("Stato", "Guasti", "Aree e avvisi", "AP vicini"), networkTabTitles(emptyMap()))
        assertEquals(listOf("Stato", "Guasti", "Aree e avvisi"), networkTabTitles(mapOf("compass" to false)))
        assertEquals(listOf("Da completare", "Storico", "Salute CPE"), installTabTitles(emptyMap(), admin = true))
    }
}
