package it.cdanet.cpeconfigurator.data

import android.content.Context
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import java.io.File
import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

/** One "Trova l'AP" answer kept for use without network on the roof. */
@Serializable
data class CachedPointing(
    val userId: Int,
    val savedAt: Long,
    /** Customer of the work order it was downloaded for, null = the installer's own position. */
    val label: String? = null,
    val data: PointingDto,
)

/**
 * "Trova l'AP" answers already received (and the ones downloaded ahead for the day's work orders),
 * so the nearby APs with azimuth and tilt are there even where the roof has no mobile signal. Only
 * what the server already sent to this account is kept (installers get no AP coordinates), for
 * [MAX_AGE_MS], and only for the last account that used the phone.
 */
class PointingCache(context: Context) {
    private val file = File(context.filesDir, "pointing-cache.json")
    private val serializer = ListSerializer(CachedPointing.serializer())

    @Synchronized
    private fun load(): List<CachedPointing> =
        runCatching { AppJson.decodeFromString(serializer, file.readText()) }.getOrDefault(emptyList())

    @Synchronized
    private fun save(items: List<CachedPointing>) {
        val tmp = File(file.parentFile, "${file.name}.tmp")
        tmp.writeText(AppJson.encodeToString(serializer, items))
        tmp.renameTo(file)
    }

    /** Keeps [d]; an answer for (about) the same place replaces the old one. */
    @Synchronized
    fun put(userId: Int, d: PointingDto, label: String? = null, now: Long = System.currentTimeMillis()) {
        save(merge(load(), CachedPointing(userId, now, label, d), now))
    }

    /** The saved answer closest to here within [maxM], for [userId] (null = whoever used the phone last). */
    fun near(userId: Int?, lat: Double, lon: Double, maxM: Int = MAX_DISTANCE_M, now: Long = System.currentTimeMillis()): Pair<CachedPointing, Int>? =
        nearest(load(), userId, lat, lon, maxM, now)

    /**
     * Downloads ahead the APs around the day's work orders ([places]: label, lat, lon), skipping
     * the ones saved in the last 12 hours, so they are on the phone before reaching the roof.
     */
    suspend fun prefetch(api: ApiClient, userId: Int, places: List<Triple<String, Double, Double>>) {
        val now = System.currentTimeMillis()
        for ((label, lat, lon) in places) {
            val have = near(userId, lat, lon, 100, now)
            if (have != null && now - have.first.savedAt < 12L * 3600 * 1000) continue
            runCatching { api.pointing(lat, lon, null) }.onSuccess { put(userId, it, label) }
        }
    }

    @Synchronized
    fun clear() {
        file.delete()
    }

    companion object {
        const val MAX_AGE_MS = 14L * 24 * 3600 * 1000
        /** Within a few hundred metres azimuth and tilt of APs kilometres away barely change. */
        const val MAX_DISTANCE_M = 400
        private const val MAX_ITEMS = 40

        /** "AP salvati il 9/10 alle 08:12 per Rossi Mario, a 120 m da qui." */
        fun describe(e: CachedPointing, distanceM: Int): String {
            val at = java.text.SimpleDateFormat("d/M 'alle' HH:mm", java.util.Locale.ITALY).format(java.util.Date(e.savedAt))
            return "Senza rete: uso gli AP salvati il $at" + (e.label?.let { " per $it" } ?: "") + ", a $distanceM m da qui. Azimut e tilt sono quelli calcolati da quel punto."
        }

        fun distanceM(lat1: Double, lon1: Double, lat2: Double, lon2: Double): Int {
            val r = 6371000.0
            val dLat = Math.toRadians(lat2 - lat1)
            val dLon = Math.toRadians(lon2 - lon1)
            val a = sin(dLat / 2).pow(2) + cos(Math.toRadians(lat1)) * cos(Math.toRadians(lat2)) * sin(dLon / 2).pow(2)
            return (2 * r * asin(sqrt(a))).toInt()
        }

        /** Pure: another account's answers go, stale ones go, a nearby one is replaced. */
        fun merge(items: List<CachedPointing>, add: CachedPointing, now: Long): List<CachedPointing> {
            val keep = items.filter {
                it.userId == add.userId && now - it.savedAt < MAX_AGE_MS &&
                    distanceM(it.data.from.lat, it.data.from.lon, add.data.from.lat, add.data.from.lon) > 50
            }
            return (keep + add).sortedBy { it.savedAt }.takeLast(MAX_ITEMS)
        }

        fun nearest(items: List<CachedPointing>, userId: Int?, lat: Double, lon: Double, maxM: Int, now: Long): Pair<CachedPointing, Int>? =
            items.asSequence()
                .filter { (userId == null || it.userId == userId) && now - it.savedAt < MAX_AGE_MS }
                .map { it to distanceM(lat, lon, it.data.from.lat, it.data.from.lon) }
                .filter { it.second <= maxM }
                .minByOrNull { it.second }
    }
}
