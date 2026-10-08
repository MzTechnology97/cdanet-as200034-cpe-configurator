package it.cdanet.cpeconfigurator

import it.cdanet.cpeconfigurator.data.AppJson
import it.cdanet.cpeconfigurator.data.LoginStep
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LoginStepTest {
    @Test
    fun decodesBothLoginResponses() {
        val session = AppJson.decodeFromString(LoginStep.serializer(), """{"token":"t","expiresAt":"2026-10-09T10:00:00Z","user":{"id":2,"username":"tecnico","role":"installer"}}""")
        assertEquals("t", session.token)
        assertEquals("tecnico", session.user?.username)
        assertTrue(!session.mfaRequired)

        val mfa = AppJson.decodeFromString(LoginStep.serializer(), """{"mfaRequired":true,"mfaToken":"m"}""")
        assertTrue(mfa.mfaRequired)
        assertEquals("m", mfa.mfaToken)
        assertNull(mfa.token)
    }
}
