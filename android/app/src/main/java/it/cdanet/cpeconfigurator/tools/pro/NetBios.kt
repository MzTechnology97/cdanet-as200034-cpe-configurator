package it.cdanet.cpeconfigurator.tools.pro

data class NetBiosInfo(val names: List<String>, val mac: String?)

/** NetBIOS node status (NBSTAT, UDP 137): names and MAC of Windows/Samba hosts. */
object NetBios {
    val QUERY: ByteArray = ByteArray(50).also { q ->
        q[0] = 0x43; q[1] = 0x44; q[5] = 1; q[12] = 32
        for (i in 0 until 16) {
            val v = if (i == 0) 0x2a else 0x20
            q[13 + i * 2] = (65 + ((v shr 4) and 15)).toByte()
            q[14 + i * 2] = (65 + (v and 15)).toByte()
        }
        q[47] = 0x21; q[49] = 1
    }

    fun parse(buf: ByteArray, len: Int): NetBiosInfo? {
        if (len < 57) return null
        val count = buf[56].toInt() and 0xff
        val names = (0 until count).mapNotNull { i ->
            val off = 57 + i * 18
            if (off + 15 > len) null else String(buf, off, 15, Charsets.US_ASCII).trim { it <= ' ' }.ifBlank { null }
        }.distinct()
        // The unit ID (MAC) follows the name table; all zeros on Samba.
        val macOff = 57 + count * 18
        val mac = if (macOff + 6 <= len) (0 until 6).map { buf[macOff + it].toInt() and 0xff } else null
        val macText = mac?.takeIf { m -> m.any { it != 0 } }?.joinToString(":") { "%02X".format(it) }
        return NetBiosInfo(names, macText)
    }
}
