package it.cdanet.cpeconfigurator.tools

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import kotlin.random.Random

/** Minimal SNMP v2c GET (BER), mirrors server/src/net/snmp.ts. */
object Snmp {
    private fun length(n: Int): ByteArray = when {
        n < 0x80 -> byteArrayOf(n.toByte())
        n < 0x100 -> byteArrayOf(0x81.toByte(), n.toByte())
        else -> byteArrayOf(0x82.toByte(), (n shr 8).toByte(), n.toByte())
    }

    fun tlv(tag: Int, value: ByteArray): ByteArray = byteArrayOf(tag.toByte()) + length(value.size) + value

    fun encodeOid(oid: String): ByteArray {
        val parts = oid.split(".").map { it.toLong() }
        require(parts.size >= 2) { "OID non valido" }
        val out = ByteArrayOutputStream()
        out.write((parts[0] * 40 + parts[1]).toInt())
        for (v0 in parts.drop(2)) {
            var v = v0
            val stack = ArrayDeque<Int>()
            stack.addFirst((v and 0x7f).toInt())
            v = v shr 7
            while (v > 0) {
                stack.addFirst(((v and 0x7f) or 0x80).toInt())
                v = v shr 7
            }
            stack.forEach { out.write(it) }
        }
        return out.toByteArray()
    }

    fun decodeOid(b: ByteArray): String {
        if (b.isEmpty()) return ""
        val first = b[0].toInt() and 0xff
        val parts = mutableListOf<Long>(first / 40L, first % 40L)
        var v = 0L
        for (i in 1 until b.size) {
            val x = b[i].toInt() and 0xff
            v = (v shl 7) or (x and 0x7f).toLong()
            if (x and 0x80 == 0) {
                parts += v
                v = 0
            }
        }
        return parts.joinToString(".")
    }

    private fun integer(n: Int): ByteArray {
        val bytes = mutableListOf<Byte>()
        var x = n.toLong()
        do {
            bytes.add(0, (x and 0xff).toByte())
            x = x shr 8
        } while (x > 0)
        if (bytes[0].toInt() and 0x80 != 0) bytes.add(0, 0)
        return tlv(0x02, bytes.toByteArray())
    }

    fun getRequest(community: String, oids: List<String>, requestId: Int): ByteArray {
        val vbs = oids.fold(ByteArray(0)) { acc, o -> acc + tlv(0x30, tlv(0x06, encodeOid(o)) + byteArrayOf(0x05, 0x00)) }
        val pdu = tlv(0xa0, integer(requestId) + integer(0) + integer(0) + tlv(0x30, vbs))
        return tlv(0x30, integer(1) + tlv(0x04, community.toByteArray(Charsets.UTF_8)) + pdu)
    }

    private class Node(val tag: Int, val value: ByteArray, val end: Int)

    private fun read(buf: ByteArray, pos: Int, limit: Int = buf.size): Node {
        if (pos + 2 > limit) throw IOException("BER troncato")
        val tag = buf[pos].toInt() and 0xff
        var len = buf[pos + 1].toInt() and 0xff
        var p = pos + 2
        if (len and 0x80 != 0) {
            val n = len and 0x7f
            if (n < 1 || n > 3 || p + n > limit) throw IOException("Lunghezza BER non valida")
            len = 0
            repeat(n) { len = (len shl 8) or (buf[p++].toInt() and 0xff) }
        }
        if (p + len > limit) throw IOException("BER troncato")
        return Node(tag, buf.copyOfRange(p, p + len), p + len)
    }

    private fun children(b: ByteArray): List<Node> {
        val out = mutableListOf<Node>()
        var p = 0
        while (p < b.size) {
            val n = read(b, p)
            out += n
            p = n.end
        }
        return out
    }

    private fun value(tag: Int, v: ByteArray): String? = when (tag) {
        0x04 -> String(v, Charsets.UTF_8).trimEnd('\u0000').trim()
        0x02, 0x41, 0x42, 0x43, 0x46 -> {
            var n = java.math.BigInteger.ZERO
            for (x in v) n = n.shiftLeft(8).or(java.math.BigInteger.valueOf((x.toInt() and 0xff).toLong()))
            if (tag == 0x02 && v.isNotEmpty() && v[0].toInt() and 0x80 != 0) n = n.subtract(java.math.BigInteger.ONE.shiftLeft(v.size * 8))
            if (tag == 0x43) ticks(n.toLong()) else n.toString()
        }
        0x40 -> if (v.size == 4) v.joinToString(".") { (it.toInt() and 0xff).toString() } else null
        0x06 -> decodeOid(v)
        0x05, 0x80, 0x81, 0x82 -> null
        else -> "0x" + v.joinToString("") { "%02X".format(it) }
    }

    private fun ticks(t: Long): String {
        var s = t / 100
        val d = s / 86400; s %= 86400
        val h = s / 3600; s %= 3600
        return "${d}g ${h}h ${s / 60}m ${s % 60}s"
    }

    data class Response(val requestId: Int, val errorStatus: Int, val values: Map<String, String?>)

    fun parse(buf: ByteArray, length: Int = buf.size): Response {
        val msg = read(buf, 0, length)
        val parts = children(msg.value)
        val pdu = parts.getOrNull(2) ?: throw IOException("Risposta SNMP non valida")
        if (pdu.tag != 0xa2) throw IOException("PDU SNMP non valida")
        val fields = children(pdu.value)
        if (fields.size < 4) throw IOException("PDU SNMP incompleta")
        val values = linkedMapOf<String, String?>()
        for (vb in children(fields[3].value)) {
            val kv = children(vb.value)
            if (kv.size == 2) values[decodeOid(kv[0].value)] = value(kv[1].tag, kv[1].value)
        }
        return Response(value(0x02, fields[0].value)!!.toInt(), value(0x02, fields[1].value)!!.toInt(), values)
    }

    fun get(host: String, community: String, oids: List<String>, timeoutMs: Int = 2500): Map<String, String?> {
        val id = Random.nextInt(1, Int.MAX_VALUE)
        val msg = getRequest(community, oids, id)
        DatagramSocket().use { s ->
            s.soTimeout = timeoutMs
            s.send(DatagramPacket(msg, msg.size, InetAddress.getByName(host), 161))
            val buf = ByteArray(8192)
            val deadline = System.currentTimeMillis() + timeoutMs
            while (System.currentTimeMillis() < deadline) {
                val p = DatagramPacket(buf, buf.size)
                s.receive(p)
                val r = parse(buf, p.length)
                if (r.requestId != id) continue
                if (r.errorStatus != 0) throw IOException("Errore SNMP ${r.errorStatus}")
                return r.values
            }
            throw IOException("Timeout SNMP")
        }
    }

    // ---- Tables (GETBULK walk) for the network topology ---------------------------------------

    /** One varbind with its raw value (MAC addresses are binary octet strings). */
    class Var(val oid: String, val tag: Int, val raw: ByteArray) {
        val text: String get() = value(tag, raw).orEmpty()
        val int: Long? get() = if (tag in setOf(0x02, 0x41, 0x42, 0x43, 0x46)) value(tag, raw)?.toLongOrNull() else null
        /** 6-byte octet string as "AA:BB:CC:DD:EE:FF", else null. */
        val mac: String? get() = if (tag == 0x04 && raw.size == 6) raw.joinToString(":") { "%02X".format(it) } else null
        val endOfView: Boolean get() = tag in 0x80..0x82
    }

    fun bulkRequest(community: String, oid: String, requestId: Int, maxRepetitions: Int): ByteArray {
        val vbs = tlv(0x30, tlv(0x06, encodeOid(oid)) + byteArrayOf(0x05, 0x00))
        val pdu = tlv(0xa5, integer(requestId) + integer(0) + integer(maxRepetitions) + tlv(0x30, vbs))
        return tlv(0x30, integer(1) + tlv(0x04, community.toByteArray(Charsets.UTF_8)) + pdu)
    }

    fun parseVars(buf: ByteArray, length: Int = buf.size): Pair<Int, List<Var>> {
        val msg = read(buf, 0, length)
        val parts = children(msg.value)
        val pdu = parts.getOrNull(2) ?: throw IOException("Risposta SNMP non valida")
        if (pdu.tag != 0xa2) throw IOException("PDU SNMP non valida")
        val fields = children(pdu.value)
        if (fields.size < 4) throw IOException("PDU SNMP incompleta")
        val vars = children(fields[3].value).mapNotNull { vb ->
            val kv = children(vb.value)
            if (kv.size == 2) Var(decodeOid(kv[0].value), kv[1].tag, kv[1].value) else null
        }
        return value(0x02, fields[0].value)!!.toInt() to vars
    }

    /**
     * All rows under [root] (GETBULK, v2c). Stops at the end of the subtree, after [maxRows] or at
     * the first timeout of a page (what was read so far is returned).
     */
    fun walk(host: String, community: String, root: String, maxRows: Int = 4000, timeoutMs: Int = 1500): List<Var> {
        val out = mutableListOf<Var>()
        var next = root
        DatagramSocket().use { s ->
            s.soTimeout = timeoutMs
            val addr = InetAddress.getByName(host)
            val buf = ByteArray(65535)
            while (out.size < maxRows) {
                val id = Random.nextInt(1, Int.MAX_VALUE)
                val msg = bulkRequest(community, next, id, 25)
                var page: List<Var>? = null
                for (attempt in 0..1) {
                    s.send(DatagramPacket(msg, msg.size, addr, 161))
                    try {
                        while (page == null) {
                            val p = DatagramPacket(buf, buf.size)
                            s.receive(p)
                            val (rid, vars) = parseVars(buf, p.length)
                            if (rid == id) page = vars
                        }
                        break
                    } catch (_: java.net.SocketTimeoutException) {
                    }
                }
                val vars = page ?: break
                var advanced = false
                for (v in vars) {
                    if (v.endOfView || !v.oid.startsWith("$root.")) return out
                    out += v
                    next = v.oid
                    advanced = true
                }
                if (!advanced) break
            }
        }
        return out
    }
}
