package it.cdanet.cpeconfigurator.network

import java.net.Inet4Address
import java.net.InetAddress

object Ip {
    private val IPV4 = Regex("""^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$""")

    fun parse(ip: String): Long? {
        val m = IPV4.matchEntire(ip.trim()) ?: return null
        var n = 0L
        for (g in m.groupValues.drop(1)) {
            val x = g.toInt()
            if (x > 255) return null
            n = (n shl 8) or x.toLong()
        }
        return n
    }

    fun format(n: Long): String = "${(n shr 24) and 255}.${(n shr 16) and 255}.${(n shr 8) and 255}.${n and 255}"

    /** RFC1918, CGNAT 100.64/10, link-local, loopback. */
    fun isPrivate(ip: String): Boolean {
        val n = parse(ip) ?: return false
        val a = n shr 24
        val b = (n shr 16) and 255
        return a == 10L || (a == 172L && b in 16..31) || (a == 192L && b == 168L) ||
            (a == 100L && b in 64..127) || (a == 169L && b == 254L) || a == 127L
    }

    /** Without DNS: private IPv4 literal, localhost or *.local / *.lan / *.internal names. */
    fun isPrivateLiteralOrLocalName(host: String): Boolean {
        val h = host.lowercase()
        return isPrivate(h) || h == "localhost" || h.endsWith(".local") || h.endsWith(".lan") || h.endsWith(".internal")
    }

    /** Resolves and returns the IPv4 only if it is private/CGNAT. */
    fun resolvePrivate(host: String): String {
        val addr = InetAddress.getAllByName(host.trim()).firstOrNull { it is Inet4Address }
            ?: throw IllegalArgumentException("Host non risolvibile in IPv4")
        val ip = addr.hostAddress ?: throw IllegalArgumentException("Host non valido")
        if (!isPrivate(ip)) throw IllegalArgumentException("Consentiti solo target su reti private/CGNAT")
        return ip
    }

    data class Cidr(val network: Long, val prefix: Int) {
        val mask: Long get() = if (prefix == 0) 0 else (0xffffffffL shl (32 - prefix)) and 0xffffffffL
        val broadcast: Long get() = network or (mask.inv() and 0xffffffffL)
        val first: Long get() = if (prefix >= 31) network else network + 1
        val last: Long get() = if (prefix >= 31) broadcast else broadcast - 1
        override fun toString() = "${format(network)}/$prefix"
    }

    fun parseCidr(text: String): Cidr {
        val parts = text.trim().split("/")
        val ip = parse(parts[0]) ?: throw IllegalArgumentException("IPv4/CIDR non valido")
        val prefix = parts.getOrNull(1)?.toIntOrNull() ?: 24
        if (prefix !in 0..32) throw IllegalArgumentException("Prefisso non valido")
        val mask = if (prefix == 0) 0L else (0xffffffffL shl (32 - prefix)) and 0xffffffffL
        return Cidr(ip and mask, prefix)
    }

    /** Scans are limited to private /24 (or smaller) networks. */
    fun parseScanCidr(text: String): Cidr {
        val c = parseCidr(text)
        if (c.prefix < 24) throw IllegalArgumentException("Scansione limitata a /24 o reti più piccole")
        if (!isPrivate(format(c.network))) throw IllegalArgumentException("Consentite solo reti private/CGNAT")
        return c
    }
}
