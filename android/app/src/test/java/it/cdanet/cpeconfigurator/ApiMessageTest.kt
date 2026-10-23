package it.cdanet.cpeconfigurator

import it.cdanet.cpeconfigurator.data.apiMessage
import it.cdanet.cpeconfigurator.data.blockedIpMessage
import org.junit.Assert.assertTrue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class ApiMessageTest {
    @Test
    fun codesNamingADataSourceAreNeverShown() {
        for (code in listOf("uisp_device_not_found", "uisp_error", "crm_unreachable", "uisp_crm_error")) {
            val m = apiMessage(code)
            assertFalse(m, m.contains("uisp", ignoreCase = true) || m.contains("crm", ignoreCase = true))
        }
    }

    @Test
    fun blockedAddressSaysWhichAndWhoUnblocks() {
        val m = blockedIpMessage("203.0.113.9")
        assertTrue(m, m.contains("203.0.113.9") && m.contains("NOC") && m.contains("Accessi bloccati"))
        // never the name of the protection behind it
        assertFalse(m, m.contains("crowdsec", ignoreCase = true))
        assertFalse(blockedIpMessage(null).contains("null"))
    }

    @Test
    fun knownAndUnknownCodes() {
        assertEquals("Codice non valido", apiMessage("invalid_code"))
        assertEquals("something_else", apiMessage("something_else"))
    }
}
