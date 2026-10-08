package it.cdanet.cpeconfigurator.tools

import kotlin.math.abs

/** A Wi-Fi network seen by the phone: primary channel frequency, signal and width. */
data class SeenNetwork(val frequencyMhz: Int, val levelDbm: Int, val widthMhz: Int = 20)

data class ChannelAdvice(val band: String, val channel: Int, val networksOnIt: Int, val strongestDbm: Int?)

/**
 * Least crowded channel for the customer's router: 1/6/11 in 2.4 GHz (overlap-aware),
 * 36-48 in 5 GHz (no DFS, no radar waits). Weighted by signal: a strong neighbour counts more.
 */
object ChannelAdvisor {
    fun channelOf(freq: Int): Int = when {
        freq == 2484 -> 14
        freq in 2412..2472 -> (freq - 2407) / 5
        freq in 5000..5895 -> (freq - 5000) / 5
        else -> 0
    }

    private fun weight(level: Int) = (level + 100).coerceAtLeast(1).toDouble()

    fun best24(nets: List<SeenNetwork>): ChannelAdvice {
        val on24 = nets.filter { it.frequencyMhz in 2400..2500 }
        // 20 MHz channels overlap up to 4 channels apart (5 MHz spacing).
        fun overlap(a: Int, b: Int) = (1.0 - abs(a - b) / 5.0).coerceAtLeast(0.0)
        val best = listOf(1, 6, 11).minBy { c -> on24.sumOf { overlap(channelOf(it.frequencyMhz), c) * weight(it.levelDbm) } }
        val same = on24.filter { abs(channelOf(it.frequencyMhz) - best) <= 2 }
        return ChannelAdvice("2.4 GHz", best, same.size, same.maxOfOrNull { it.levelDbm })
    }

    /** Channels covered by a 5 GHz network of the given width (aligned 20/40/80/160 MHz blocks). */
    fun covered5(primary: Int, widthMhz: Int): IntRange {
        val n = (widthMhz / 20).coerceIn(1, 8)
        val span = 4 * n
        val origin = if (primary >= 149) 149 else 36 // UNII-3 blocks start at 149
        val base = origin + ((primary - origin).coerceAtLeast(0) / span) * span
        return base..(base + span - 4)
    }

    fun best5(nets: List<SeenNetwork>): ChannelAdvice {
        val on5 = nets.filter { it.frequencyMhz in 5150..5895 }
        val candidates = listOf(36, 40, 44, 48)
        fun users(c: Int) = on5.filter { c in covered5(channelOf(it.frequencyMhz), it.widthMhz) && (c - covered5(channelOf(it.frequencyMhz), it.widthMhz).first) % 4 == 0 }
        val best = candidates.minBy { c -> users(c).sumOf { weight(it.levelDbm) } }
        val u = users(best)
        return ChannelAdvice("5 GHz", best, u.size, u.maxOfOrNull { it.levelDbm })
    }

    fun describe(a: ChannelAdvice) =
        "${a.band}: canale ${a.channel}" + if (a.networksOnIt == 0) " (libero)" else " (${a.networksOnIt} reti, la più forte ${a.strongestDbm} dBm)"
}
