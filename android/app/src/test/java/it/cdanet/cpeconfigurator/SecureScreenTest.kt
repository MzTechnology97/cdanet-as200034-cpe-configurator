package it.cdanet.cpeconfigurator

import it.cdanet.cpeconfigurator.core.SecureScreen
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SecureScreenTest {
    @Test
    fun adminsAlwaysMay() {
        assertFalse(SecureScreen.blocked("admin", null))
        assertFalse(SecureScreen.blocked("admin", mapOf("screenshots" to false)))
    }

    @Test
    fun othersOnlyWhenTheServerAllowsIt() {
        assertTrue(SecureScreen.blocked("installer", null))
        assertTrue(SecureScreen.blocked("installer", mapOf("screenshots" to false)))
        assertTrue(SecureScreen.blocked("installer", emptyMap()))
        assertFalse(SecureScreen.blocked("installer", mapOf("screenshots" to true)))
    }

    @Test
    fun nobodyLoggedInIsBlocked() {
        assertTrue(SecureScreen.blocked(null, mapOf("screenshots" to true)))
    }
}
