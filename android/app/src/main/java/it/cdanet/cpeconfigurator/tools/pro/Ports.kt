package it.cdanet.cpeconfigurator.tools.pro

/** Well-known TCP services, port presets and the port-list syntax ("1-1024,8291,8728"). */
object Ports {
    val SERVICES: Map<Int, String> = mapOf(
        20 to "ftp-data", 21 to "ftp", 22 to "ssh", 23 to "telnet", 25 to "smtp", 53 to "dns", 67 to "dhcp", 69 to "tftp",
        80 to "http", 81 to "http-alt", 88 to "kerberos", 110 to "pop3", 111 to "rpcbind", 119 to "nntp", 123 to "ntp",
        135 to "msrpc", 137 to "netbios-ns", 139 to "netbios-ssn", 143 to "imap", 161 to "snmp", 179 to "bgp", 389 to "ldap",
        443 to "https", 445 to "smb", 465 to "smtps", 500 to "ike", 502 to "modbus", 515 to "lpd", 548 to "afp", 554 to "rtsp",
        587 to "submission", 631 to "ipp", 636 to "ldaps", 853 to "dns-over-tls", 873 to "rsync", 902 to "vmware", 993 to "imaps",
        995 to "pop3s", 1080 to "socks", 1194 to "openvpn", 1433 to "mssql", 1521 to "oracle", 1701 to "l2tp", 1723 to "pptp",
        1812 to "radius", 1883 to "mqtt", 1900 to "upnp", 2000 to "mikrotik-btest", 2049 to "nfs", 2121 to "ftp-alt",
        2222 to "ssh-alt", 3000 to "http-dev", 3128 to "squid", 3306 to "mysql", 3389 to "rdp", 3478 to "stun", 4433 to "https-alt",
        4500 to "ipsec-nat", 4786 to "cisco-smi", 5000 to "upnp/synology", 5001 to "synology-https", 5060 to "sip", 5061 to "sips",
        5222 to "xmpp", 5353 to "mdns", 5432 to "postgres", 5555 to "adb", 5900 to "vnc", 5985 to "winrm", 6379 to "redis",
        6667 to "irc", 7547 to "tr-069", 8000 to "http-alt/hikvision", 8001 to "http-alt", 8008 to "http-alt/cast", 8009 to "cast",
        8080 to "http-proxy", 8081 to "http-alt", 8086 to "influxdb", 8088 to "http-alt", 8123 to "home-assistant",
        8291 to "winbox", 8443 to "https-alt", 8728 to "mikrotik-api", 8729 to "mikrotik-api-ssl", 8883 to "mqtt-tls",
        8888 to "http-alt", 9000 to "http-alt", 9090 to "prometheus", 9100 to "jetdirect", 9200 to "elasticsearch",
        10000 to "webmin", 10001 to "ubnt-discovery", 11211 to "memcached", 20080 to "airos-http (CDA)", 20443 to "airos-https (CDA)",
        27017 to "mongodb", 34567 to "dvr (Xiongmai)", 37777 to "dahua", 49152 to "upnp", 62078 to "iphone-sync",
    )

    /** Ports where a TLS handshake makes sense (certificate details). */
    val TLS: Set<Int> = setOf(443, 465, 636, 853, 993, 995, 4433, 5001, 5061, 8443, 8729, 8883, 20443)

    val PRESETS: LinkedHashMap<String, List<Int>> = linkedMapOf(
        "Rapida (top 30)" to listOf(21, 22, 23, 25, 53, 80, 110, 135, 139, 143, 443, 445, 554, 993, 1723, 3306, 3389, 5900, 8000, 8080, 8291, 8443, 8728, 9100, 20080, 20443, 37777, 62078, 161, 7547),
        "Apparati di rete (CPE, router, switch)" to listOf(22, 23, 53, 80, 161, 443, 2000, 7547, 8080, 8291, 8443, 8728, 8729, 10001, 20080, 20443),
        "TVCC / NVR" to listOf(80, 443, 554, 8000, 8080, 8200, 8554, 9000, 34567, 37777, 37778),
        "Windows / server" to listOf(21, 22, 53, 80, 88, 135, 139, 389, 443, 445, 636, 1433, 3389, 5985, 5986),
        "Database" to listOf(1433, 1521, 3306, 5432, 6379, 9200, 11211, 27017),
        "Stampanti" to listOf(80, 443, 515, 631, 9100),
        "Prime 1024" to (1..1024).toList(),
    )

    fun service(port: Int): String = SERVICES[port] ?: ""

    /**
     * "22,80,8000-8100" or a preset name. Duplicates removed, sorted, 1..65535, at most [max] ports.
     */
    fun parse(spec: String, max: Int = 10_000): List<Int> {
        PRESETS[spec]?.let { return it.distinct().sorted() }
        val out = sortedSetOf<Int>()
        for (part in spec.split(',', ' ', ';').map { it.trim() }.filter { it.isNotEmpty() }) {
            val m = Regex("""^(\d{1,5})(?:\s*-\s*(\d{1,5}))?$""").find(part) ?: throw IllegalArgumentException("Porta non valida: $part")
            val a = m.groupValues[1].toInt()
            val b = m.groupValues[2].ifEmpty { m.groupValues[1] }.toInt()
            require(a in 1..65535 && b in 1..65535 && a <= b) { "Intervallo non valido: $part" }
            for (p in a..b) {
                out += p
                require(out.size <= max) { "Massimo $max porte per scansione" }
            }
        }
        require(out.isNotEmpty()) { "Nessuna porta indicata" }
        return out.toList()
    }
}
