package it.cdanet.cpeconfigurator

import it.cdanet.cpeconfigurator.ui.screens.CalView
import it.cdanet.cpeconfigurator.ui.screens.CalendarMath
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.LocalDate
import java.time.YearMonth

class CalendarMathTest {
    @Test
    fun `time slots of the orders`() {
        assertEquals(540 to 660, CalendarMath.slotMinutes("09:00-11:00"))
        assertEquals(510 to 570, CalendarMath.slotMinutes("8.30"))
        assertEquals(840 to 900, CalendarMath.slotMinutes("14:00 – 13:00"))
        assertNull(CalendarMath.slotMinutes("mattina"))
        assertNull(CalendarMath.slotMinutes(""))
        assertNull(CalendarMath.slotMinutes("25:00"))
    }

    @Test
    fun `weeks start on Monday, months show six weeks, within the server's 62 days`() {
        val wed = LocalDate.of(2026, 10, 14)
        assertEquals(LocalDate.of(2026, 10, 12), CalendarMath.weekStart(wed))
        val grid = CalendarMath.monthGrid(YearMonth.of(2026, 10))
        assertEquals(42, grid.size)
        assertEquals(LocalDate.of(2026, 9, 28), grid.first())
        assertEquals(LocalDate.of(2026, 10, 12) to LocalDate.of(2026, 10, 18), CalendarMath.range(CalView.Week, wed))
        assertEquals(LocalDate.of(2026, 11, 1), CalendarMath.shift(CalView.Month, wed, 1))
        assertEquals("12 – 18 ottobre 2026", CalendarMath.title(CalView.Week, wed))
        assertEquals("Ottobre 2026", CalendarMath.title(CalView.Month, wed))
    }

    @Test
    fun `overlapping orders go side by side`() {
        val (lane, lanes) = CalendarMath.lanes(listOf(540 to 660, 600 to 660, 660 to 720, 545 to 560))
        // 9-11 and 9:05-9:20 overlap; 10-11 reuses the lane freed at 9:20; 11-12 the first one
        assertEquals(2, lanes)
        assertEquals(listOf(0, 1, 0, 1), lane)
    }
}
