package it.cdanet.cpeconfigurator

import it.cdanet.cpeconfigurator.alerts.FeedOrder
import it.cdanet.cpeconfigurator.alerts.PhoneAlerts
import it.cdanet.cpeconfigurator.ui.screens.WorkOrderPosition
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class FieldAlertsTest {
    private val start = Instant.parse("2026-10-10T07:00:00Z")
    private fun order(id: Int = 7) = FeedOrder(id, "Cliente Demo 40", "Via Demo 1", "09:00-11:00", "Guasto", start.toString())

    @Test
    fun remindersOnlyInTheFuture() {
        val all = PhoneAlerts.reminders(listOf(order()), start.minusSeconds(30 * 3600).toEpochMilli())
        assertEquals(listOf(24 * 60, 120, 60, 30), all.map { it.offsetMin })
        assertEquals(start.minusSeconds(30 * 60).toEpochMilli(), all.last().atMs)
        assertTrue(all.first().title.contains("Cliente Demo 40"))
        // 90 minutes before: only 1 hour and 30 minutes are still to come
        assertEquals(listOf(60, 30), PhoneAlerts.reminders(listOf(order()), start.minusSeconds(90 * 60).toEpochMilli()).map { it.offsetMin })
        assertTrue(PhoneAlerts.reminders(listOf(order()), start.plusSeconds(60).toEpochMilli()).isEmpty())
        assertTrue(PhoneAlerts.reminders(listOf(order().copy(startAt = "x")), 0).isEmpty())
    }

    @Test
    fun acceptanceOnlyNearTheCustomer() {
        assertNull(WorkOrderPosition.refusal(120, 8.0, "Cliente Demo 40"))
        assertNull(WorkOrderPosition.refusal(null, null, "Cliente Demo 40"), "no reference: not blocked")
        val far = WorkOrderPosition.refusal(3200, 250.0, "Cliente Demo 40")
        assertNotNull(far)
        assertTrue(far!!.contains("3,2 km") && far.contains("Cliente Demo 40") && far.contains("precisione GPS 250 m"))
        assertEquals(1112, WorkOrderPosition.distanceM(37.57, 14.28, 37.58, 14.28), 2.0)
    }

    private fun assertNull(v: Any?, msg: String) = org.junit.Assert.assertNull(msg, v)

    private fun assertEquals(expected: Int, actual: Int, delta: Double) = org.junit.Assert.assertEquals(expected.toDouble(), actual.toDouble(), delta)
}
