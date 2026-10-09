package it.cdanet.cpeconfigurator.tools.pro

import java.io.ByteArrayOutputStream

data class DnsRecord(val name: String, val type: String, val ttl: Long, val data: String)

data class DnsAnswer(val rcode: Int, val authoritative: Boolean, val truncated: Boolean, val answers: List<DnsRecord>, val authority: List<DnsRecord>) {
    val rcodeText: String get() = when (rcode) { 0 -> "NOERROR"; 1 -> "FORMERR"; 2 -> "SERVFAIL"; 3 -> "NXDOMAIN"; 4 -> "NOTIMP"; 5 -> "REFUSED"; else -> "RCODE $rcode" }
}

/** Minimal DNS wire format (RFC 1035) to query any record type against a chosen server. */
object DnsWire {
    val TYPES: LinkedHashMap<String, Int> = linkedMapOf("A" to 1, "AAAA" to 28, "MX" to 15, "TXT" to 16, "NS" to 2, "CNAME" to 5, "SOA" to 6, "PTR" to 12, "SRV" to 33, "CAA" to 257)
    private val NAMES = TYPES.entries.associate { (k, v) -> v to k }

    /** "192.168.1.10" -> "10.1.168.192.in-addr.arpa" for PTR queries. */
    fun reverseName(ip: String): String = ip.split('.').reversed().joinToString(".") + ".in-addr.arpa"

    fun query(id: Int, name: String, type: Int): ByteArray {
        val out = ByteArrayOutputStream()
        fun u16(v: Int) { out.write((v shr 8) and 0xff); out.write(v and 0xff) }
        u16(id); u16(0x0100); u16(1); u16(0); u16(0); u16(0)
        for (label in name.trimEnd('.').split('.')) {
            val b = label.toByteArray(Charsets.US_ASCII)
            require(b.size in 1..63) { "Nome non valido" }
            out.write(b.size); out.write(b)
        }
        out.write(0)
        u16(type); u16(1)
        return out.toByteArray()
    }

    fun parse(msg: ByteArray): DnsAnswer {
        fun u8(i: Int) = msg[i].toInt() and 0xff
        fun u16(i: Int) = (u8(i) shl 8) or u8(i + 1)
        fun u32(i: Int) = (u16(i).toLong() shl 16) or u16(i + 2).toLong()
        fun name(start: Int): Pair<String, Int> {
            val labels = mutableListOf<String>()
            var i = start
            var end = -1
            var jumps = 0
            while (true) {
                val len = u8(i)
                when {
                    len == 0 -> { if (end < 0) end = i + 1; break }
                    len and 0xc0 == 0xc0 -> {
                        if (end < 0) end = i + 2
                        i = ((len and 0x3f) shl 8) or u8(i + 1)
                        require(++jumps < 32) { "loop" }
                    }
                    else -> { labels += String(msg, i + 1, len, Charsets.US_ASCII); i += len + 1 }
                }
            }
            return labels.joinToString(".") to end
        }
        require(msg.size >= 12) { "Risposta DNS troppo corta" }
        val flags = u16(2)
        val qd = u16(4); val an = u16(6); val ns = u16(8)
        var off = 12
        repeat(qd) { off = name(off).second + 4 }
        fun records(n: Int): List<DnsRecord> = (0 until n).map {
            val (nm, p) = name(off)
            val type = u16(p); val ttl = u32(p + 4); val rdLen = u16(p + 8); val rd = p + 10
            val data = when (type) {
                1 -> (0 until 4).joinToString(".") { u8(rd + it).toString() }
                28 -> (0 until 8).joinToString(":") { Integer.toHexString(u16(rd + it * 2)) }
                2, 5, 12 -> name(rd).first
                15 -> "${u16(rd)} ${name(rd + 2).first}"
                16 -> buildString {
                    var i = rd
                    while (i < rd + rdLen) { val l = u8(i); if (isNotEmpty()) append(' '); append('"').append(String(msg, i + 1, l, Charsets.UTF_8)).append('"'); i += l + 1 }
                }
                33 -> "prio ${u16(rd)} peso ${u16(rd + 2)} porta ${u16(rd + 4)} ${name(rd + 6).first}"
                6 -> { val (mname, a) = name(rd); val (rname, b) = name(a); "$mname $rname serial ${u32(b)}" }
                else -> "${rdLen} byte"
            }
            off = rd + rdLen
            DnsRecord(nm, NAMES[type] ?: "TYPE$type", ttl, data)
        }
        val answers = records(an)
        val authority = records(ns)
        return DnsAnswer(flags and 0x0f, flags and 0x0400 != 0, flags and 0x0200 != 0, answers, authority)
    }
}
