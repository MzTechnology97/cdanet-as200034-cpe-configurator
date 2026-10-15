package it.cdanet.cpeconfigurator.tools.pro

/**
 * The MAC of a LAN device without the ARP table (Android 10+ keeps it from apps): what devices
 * reveal about themselves in mDNS and UPnP, and their IPv6 link-local address (EUI-64). Pure, tested.
 */
object MacHints {
    private val HEX12 = Regex("""^[0-9A-Fa-f]{12}$""")
    private val SEPARATED = Regex("""^[0-9A-Fa-f]{2}([:-])[0-9A-Fa-f]{2}(\1[0-9A-Fa-f]{2}){4}$""")

    /** "AA:BB:CC:DD:EE:FF" from 12 hex digits (any separator), null when it is not a usable device MAC. */
    fun normalize(raw: String?): String? {
        val s = raw?.trim() ?: return null
        val hex = when {
            SEPARATED.matches(s) -> s.replace(":", "").replace("-", "")
            HEX12.matches(s) -> s
            else -> return null
        }.uppercase()
        val first = hex.substring(0, 2).toInt(16)
        // a group address, all zeros or all ones is never a device
        if (first and 1 == 1 || hex == "000000000000" || hex == "FFFFFFFFFFFF") return null
        return hex.chunked(2).joinToString(":")
    }

    /** Locally administered (randomised by phones and computers for privacy): no vendor behind it. */
    fun isPrivate(mac: String?): Boolean = normalize(mac)?.let { it.substring(0, 2).toInt(16) and 2 == 2 } ?: false

    /**
     * MAC from an IPv6 link-local address built with EUI-64 (fe80::xxxx:xxff:fexx:xxxx): the U/L bit
     * flipped back. Null for random (privacy) or manual interface identifiers.
     */
    fun fromEui64(ipv6: String): String? {
        val addr = ipv6.substringBefore('%').lowercase()
        if (!addr.startsWith("fe80:")) return null
        val groups = expand(addr) ?: return null
        val iid = groups.takeLast(4).joinToString("") { it.padStart(4, '0') }
        if (iid.substring(6, 10) != "fffe") return null
        val b = iid.chunked(2).map { it.toInt(16) }.toMutableList()
        b[0] = b[0] xor 0x02
        return normalize(listOf(b[0], b[1], b[2], b[5], b[6], b[7]).joinToString("") { "%02X".format(it) })
    }

    /** The eight groups of an IPv6 address ("::" expanded), null when it is not one. */
    private fun expand(a: String): List<String>? {
        val parts = a.split("::")
        if (parts.size > 2) return null
        val head = parts[0].split(':').filter { it.isNotEmpty() }
        val tail = parts.getOrNull(1)?.split(':')?.filter { it.isNotEmpty() }.orEmpty()
        val zeros = 8 - head.size - tail.size
        if (zeros < 0 || (parts.size == 1 && zeros != 0)) return null
        val all = head + List(zeros) { "0" } + tail
        return all.takeIf { g -> g.size == 8 && g.all { it.length in 1..4 && it.all { c -> c.isDigit() || c in 'a'..'f' } } }
    }

    /**
     * mDNS: TXT keys that carry the MAC (AirPlay «deviceid», «mac», «macaddress»…), AirPlay audio
     * instances «AABBCCDDEEFF@Nome», and the EUI-64 of an AAAA link-local record.
     */
    fun fromMdns(txt: Map<String, String>, instances: List<String>, aaaa: List<String>): String? {
        for (k in listOf("deviceid", "mac", "macaddress", "mac_address", "hwaddr", "hw_addr")) normalize(txt[k])?.let { return it }
        instances.firstNotNullOfOrNull { i -> i.substringBefore('@', "").takeIf { '@' in i }?.let { normalize(it) } }?.let { return it }
        return aaaa.firstNotNullOfOrNull { fromEui64(it) }
    }

    /**
     * UPnP description: a serial number that is a MAC, the Sonos «RINCON_<MAC>» name, or the last
     * group of the UDN when it is 12 hex digits of a real (vendor) address, as routers and ONTs do.
     */
    fun fromUpnp(desc: Map<String, String>): String? {
        normalize(desc["serialNumber"])?.let { return it }
        val udn = desc["UDN"].orEmpty()
        Regex("""RINCON_([0-9A-Fa-f]{12})""").find(udn)?.let { return normalize(it.groupValues[1]) }
        val last = udn.substringAfterLast('-', "")
        return normalize(last)?.takeIf { !isPrivate(it) }
    }

    /** How the MAC was learned, as the list and the details say it. */
    fun sourceLabel(source: String?): String = when (source) {
        null, "" -> ""
        "router" -> "dalla tabella ARP del router (SNMP)"
        "ARP" -> "dalla tabella ARP del telefono"
        "IPv6" -> "dall'indirizzo IPv6 del dispositivo"
        else -> "dalla risposta $source del dispositivo"
    }
}
