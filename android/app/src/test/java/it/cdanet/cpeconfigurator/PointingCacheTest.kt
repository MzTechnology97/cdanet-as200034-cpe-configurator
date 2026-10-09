package it.cdanet.cpeconfigurator

import it.cdanet.cpeconfigurator.data.CachedPointing
import it.cdanet.cpeconfigurator.data.PointingCache
import it.cdanet.cpeconfigurator.data.PointingDto
import it.cdanet.cpeconfigurator.data.PointingFromDto
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PointingCacheTest {
    private fun at(user: Int, lat: Double, lon: Double, savedAt: Long, label: String? = null) =
        CachedPointing(user, savedAt, label, PointingDto(from = PointingFromDto(lat, lon)))

    @Test
    fun replacesTheSamePlaceAndDropsOtherAccounts() {
        val now = 1_000_000_000_000L
        var items = PointingCache.merge(emptyList(), at(1, 37.5, 14.1, now - 1000, "Rossi"), now)
        items = PointingCache.merge(items, at(2, 37.6, 14.2, now - 500), now)
        assertEquals(listOf(2), items.map { it.userId })
        items = PointingCache.merge(items, at(2, 37.6001, 14.2001, now), now)
        assertEquals(1, items.size)
        assertEquals(now, items.single().savedAt)
    }

    @Test
    fun findsTheNearestFreshAnswerWithinRange() {
        val now = 1_000_000_000_000L
        val items = listOf(
            at(1, 37.5000, 14.1000, now - 3600_000, "Rossi"),
            at(1, 37.5100, 14.1000, now - 3600_000, "Bianchi"),
            at(1, 37.5003, 14.1000, now - PointingCache.MAX_AGE_MS - 1, "vecchio"),
        )
        val hit = PointingCache.nearest(items, 1, 37.5002, 14.1, 400, now)
        assertEquals("Rossi", hit?.first?.label)
        assertEquals(22, hit?.second)
        assertNull(PointingCache.nearest(items, 1, 37.55, 14.1, 400, now))
        assertNull(PointingCache.nearest(items, 7, 37.5, 14.1, 400, now))
        assertEquals("Rossi", PointingCache.nearest(items, null, 37.5, 14.1, 400, now)?.first?.label)
    }
}
