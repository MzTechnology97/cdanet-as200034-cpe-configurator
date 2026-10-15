package it.cdanet.cpeconfigurator

import it.cdanet.cpeconfigurator.data.AcceptanceOverrideDto
import it.cdanet.cpeconfigurator.ui.screens.AcceptanceOverride
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AcceptanceOverrideTest {
    @Test
    fun text() {
        val o = AcceptanceOverrideDto(from = "bad", by = "admin", at = "2026-10-15T08:30:00Z", note = "Segnale stabile, cliente soddisfatto")
        assertEquals(
            "Superato per decisione del NOC (admin, 15/10/26 10:30): le misure dicevano «non superato». Motivo: Segnale stabile, cliente soddisfatto",
            AcceptanceOverride.text(o, at = "15/10/26 10:30"),
        )
        assertTrue(AcceptanceOverride.text(o.copy(from = "warn"), at = "x").contains("«con riserva»"))
    }

    @Test
    fun reasonRequired() {
        assertFalse(AcceptanceOverride.validNote("  ok "))
        assertTrue(AcceptanceOverride.validNote("Visto io"))
    }
}
