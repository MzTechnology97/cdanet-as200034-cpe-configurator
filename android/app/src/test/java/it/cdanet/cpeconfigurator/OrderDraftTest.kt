package it.cdanet.cpeconfigurator

import it.cdanet.cpeconfigurator.data.WorkOrderDto
import it.cdanet.cpeconfigurator.ui.screens.OrderDraft
import it.cdanet.cpeconfigurator.ui.screens.OrderDraftMath
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate

class OrderDraftTest {
    private val day = LocalDate.of(2026, 10, 16)

    @Test
    fun slots() {
        assertEquals("09:00-10:30", OrderDraftMath.slot("09:00", "10:30"))
        assertEquals("09:00", OrderDraftMath.slot("09:00", ""))
        assertEquals("09:00", OrderDraftMath.slot("09:00", "08:00"))
        assertEquals("", OrderDraftMath.slot("", "10:00"))
    }

    @Test
    fun aTapOnAnHourIsAnHourLong() {
        val d = OrderDraftMath.at(day, 14, assignedTo = 7)
        assertEquals("14:00", d.start)
        assertEquals("15:00", d.end)
        assertEquals(7L, d.assignedTo)
        assertEquals("", OrderDraftMath.at(day, null).start)
    }

    @Test
    fun fromAnOrder() {
        val o = WorkOrderDto(id = 3, day = "2026-10-16", slot = "09:30-11:00", kind = "repair", customer = "Cliente Demo", assignedTo = 5)
        val d = OrderDraftMath.of(o)
        assertEquals("09:30", d.start)
        assertEquals("11:00", d.end)
        assertEquals("repair", d.kind)
        assertEquals(5L, d.assignedTo)
    }

    @Test
    fun problems() {
        assertNotNull(OrderDraftMath.problem(OrderDraft(day, customer = "A")))
        assertNotNull(OrderDraftMath.problem(OrderDraft(day, "10:00", "09:00", customer = "Cliente Demo")))
        assertNull(OrderDraftMath.problem(OrderDraft(day, "09:00", "10:00", customer = "Cliente Demo")))
    }

    @Test
    fun aNewOrderSendsEveryField() {
        val b = OrderDraftMath.body(OrderDraft(day, "09:00", "10:00", customer = " Cliente Demo ", address = "Via Demo 1"))
        assertEquals("2026-10-16", b["day"]!!.jsonPrimitive.content)
        assertEquals("09:00-10:00", b["slot"]!!.jsonPrimitive.content)
        assertEquals("Cliente Demo", b["customer"]!!.jsonPrimitive.content)
        assertEquals(JsonNull, b["assignedTo"])
        assertFalse("pppoePassword" in b)
    }

    @Test
    fun aMoveSendsOnlyWhatChanged() {
        val before = OrderDraft(day, "09:00", "10:00", assignedTo = 5, customer = "Cliente Demo", address = "Via Demo 1")
        val b = OrderDraftMath.body(before.copy(day = day.plusDays(1), start = "14:00", end = "15:00", assignedTo = 6), before)
        assertEquals(setOf("day", "slot", "assignedTo"), b.keys)
        // the address untouched: the position already found for it stays
        assertFalse("address" in b)
        assertTrue("pppoePassword" in OrderDraftMath.body(before.copy(pppoePassword = "x"), before))
    }

    @Test
    fun aCrmSiteFillsTheOrderWithItsPosition() {
        val cu = it.cdanet.cpeconfigurator.data.WorkOrderCrmCustomer(name = "ROSSI MARIO", phone = "3330000000")
        val site = it.cdanet.cpeconfigurator.data.WorkOrderCrmSite(pppoeUser = "rossi.mario@cda-net.it", address = "Via Demo 7, Enna", lat = 37.56, lon = 14.27)
        val d = OrderDraftMath.fromCrm(OrderDraft(day, notes = "citofono"), cu, site)
        assertEquals("ROSSI MARIO", d.customer)
        assertEquals("rossi.mario@cda-net.it", d.pppoeUser)
        assertEquals("3330000000", d.contact)
        assertEquals("citofono", d.notes)
        val b = OrderDraftMath.body(d)
        assertEquals(37.56, b["lat"]!!.jsonPrimitive.content.toDouble(), 1e-9)
        // a site without a position: the server finds it from the address
        val noPos = OrderDraftMath.fromCrm(OrderDraft(day), cu, site.copy(lat = null, lon = null))
        assertNull(noPos.lat)
        assertFalse("lat" in OrderDraftMath.body(noPos))
    }
}
