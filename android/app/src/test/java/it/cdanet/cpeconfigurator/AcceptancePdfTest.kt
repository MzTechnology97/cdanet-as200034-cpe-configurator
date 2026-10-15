package it.cdanet.cpeconfigurator

import it.cdanet.cpeconfigurator.ui.screens.AcceptancePdf
import org.junit.Assert.assertEquals
import org.junit.Test

class AcceptancePdfTest {
    @Test
    fun fileName() {
        assertEquals("rapporto-collaudo-CLIENTE-DEMO22-d81376e0.pdf", AcceptancePdf.fileName("Cliente Demo22", "d81376e0-c85b-4988-93fa-04f3b77e71d6"))
        assertEquals("rapporto-collaudo-DEMO-CDA-NET-IT-1234abcd.pdf", AcceptancePdf.fileName("demo@cda-net.it", "1234abcd-0000"))
        assertEquals("rapporto-collaudo-CPE-1234abcd.pdf", AcceptancePdf.fileName("  ", "1234abcd"))
    }
}
