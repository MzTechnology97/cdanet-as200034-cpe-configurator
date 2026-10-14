package it.cdanet.cpeconfigurator

import it.cdanet.cpeconfigurator.data.MyStockDto
import it.cdanet.cpeconfigurator.data.StockItemDto
import it.cdanet.cpeconfigurator.provisioning.MyStock
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MyStockTest {
    private val lbe = StockItemDto(model = "LiteBeam 5AC", mac = "9C:05:D6:94:62:86", serial = "9C05D6946286")

    @Test
    fun `a CPE outside the installer's warehouse blocks, unless the account may skip the check`() {
        val s = MyStock(null)
        assertNull("nothing known yet: no check", s.problem("AA:BB:CC:00:00:09"))
        s.save(MyStockDto(linked = true, site = "Impiantistica Smart", bypass = false, items = listOf(lbe)))
        assertNull(s.problem("9c05d6946286"))
        assertEquals(lbe, s.find("9C-05-D6-94-62-86"))
        assertTrue(s.problem("AA:BB:CC:00:00:09")!!.blocking)
        assertNull("not a MAC yet: the form says so", s.problem("AA:BB"))
        s.save(MyStockDto(linked = true, bypass = true, items = listOf(lbe)))
        assertEquals(false, s.problem("AA:BB:CC:00:00:09")!!.blocking)
        s.save(MyStockDto(linked = false))
        assertNull("no warehouse on the account", s.problem("AA:BB:CC:00:00:09"))
    }
}
