package it.cdanet.cpeconfigurator

import it.cdanet.cpeconfigurator.data.apiMessage
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
    fun knownAndUnknownCodes() {
        assertEquals("Codice non valido", apiMessage("invalid_code"))
        assertEquals("something_else", apiMessage("something_else"))
    }
}
