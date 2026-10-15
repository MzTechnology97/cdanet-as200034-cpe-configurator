package it.cdanet.cpeconfigurator

import it.cdanet.cpeconfigurator.data.MyStockDto
import it.cdanet.cpeconfigurator.data.StockItemDto
import it.cdanet.cpeconfigurator.provisioning.MyStock
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

class MyStockAccountTest {
    private val a = StockItemDto(model = "LiteBeam 5AC", mac = "24:A4:3C:DE:10:01")
    private val b = StockItemDto(model = "LiteBeam 5AC", mac = "24:A4:3C:DE:10:02")

    @Test
    fun `the warehouse belongs to the account on the phone`() {
        val s = MyStock(null)
        s.useAccount(7)
        s.save(MyStockDto(linked = true, bypass = false, items = listOf(a, b)))
        assertEquals(2, s.state.value!!.items.size)
        // logout: nothing to check against
        s.useAccount(null)
        assertNull(s.state.value)
        assertNull(s.problem("AA:BB:CC:00:00:09"))
        // the same account again: its list is back, also offline
        s.useAccount(7)
        assertEquals(2, s.state.value!!.items.size)
        // another account: never the previous one's
        s.useAccount(8)
        assertNull(s.state.value)
        s.useAccount(7)
        assertNull("thrown away when another account logged in", s.state.value)
    }

    @Test
    fun `an installed CPE leaves the list at once`() {
        val s = MyStock(null)
        s.useAccount(7)
        s.save(MyStockDto(linked = true, bypass = false, items = listOf(a, b)))
        assertNull(s.problem(a.mac))
        s.installed("24a43cde1001")
        assertEquals(listOf(b), s.state.value!!.items)
        assertTrue("it cannot pass the check a second time", s.problem(a.mac)!!.blocking)
    }

    @Test
    fun `an old list says when it was read`() {
        val z = ZoneId.of("Europe/Rome")
        val now = Instant.parse("2026-10-15T08:00:00Z")
        assertNull(MyStock.staleNote(true, now.minusSeconds(3 * 86400), now, z))
        assertNull("no warehouse on the account", MyStock.staleNote(false, now.minusSeconds(10 * 86400), now, z))
        val note = MyStock.staleNote(true, Instant.parse("2026-10-05T07:30:00Z"), now, z)
        assertNotNull(note)
        assertTrue(note!!.contains("05/10/2026 alle 09:30"))
    }
}
