package it.cdanet.cpeconfigurator.routeros

import it.cdanet.cpeconfigurator.data.RosCommandDto
import it.cdanet.cpeconfigurator.data.RosSectionDto

/** Mirrors server/src/domain/routeros.ts (kept in sync by unit tests on both sides). */
object RouterOsPolicy {
    private val DENY = Regex(
        """\b(add|set|remove|unset|enable|disable|reset|reboot|shutdown|upgrade|install|uninstall|move|make-supout|sup-output|export|backup|restore|fetch|upload|download|password|secret|user|certificate|script|scheduler|import|run|execute)\b""",
        RegexOption.IGNORE_CASE,
    )
    private val ALLOW = Regex("""\b(print|monitor|registration-table|profile|ping|traceroute)\b""", RegexOption.IGNORE_CASE)
    private val FORBIDDEN_CHARS = Regex("""[;\r\n`$\[\]]""")

    fun readonlyCommand(raw: String): String {
        val s = raw.trim()
        if (!s.startsWith("/")) throw IllegalArgumentException("Il comando deve iniziare con /")
        if (s.length > 300) throw IllegalArgumentException("Comando troppo lungo")
        if (FORBIDDEN_CHARS.containsMatchIn(s)) throw IllegalArgumentException("Caratteri non ammessi nel terminale in sola lettura")
        if (DENY.containsMatchIn(s)) throw IllegalArgumentException("Terminale RouterOS in sola lettura: comando di modifica bloccato")
        if (!ALLOW.containsMatchIn(s)) throw IllegalArgumentException("Sono ammessi solo comandi di lettura/diagnostica")
        return s
    }

    private val SECRET = Regex(
        """((?:password|passwd|secret|private-key|passphrase|shared-secret|authentication-key|encryption-key|wpa-pre-shared-key|wpa2-pre-shared-key)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|\S+)""",
        RegexOption.IGNORE_CASE,
    )

    fun redact(text: String): String = SECRET.replace(text) { it.groupValues[1] + "***REDACTED***" }

    fun keyValues(text: String): Map<String, String> =
        text.lineSequence().mapNotNull { Regex("""^\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$""").find(it) }
            .associate { it.groupValues[1] to it.groupValues[2].trim() }

    fun summarize(identity: String, resource: String, board: String): Map<String, String> {
        val r = keyValues(resource)
        val b = keyValues(board)
        return linkedMapOf(
            "Identity" to (keyValues(identity)["name"] ?: ""),
            "RouterOS" to (r["version"] ?: ""),
            "Board" to (r["board-name"] ?: b["model"] ?: ""),
            "Uptime" to (r["uptime"] ?: ""),
            "CPU load" to (r["cpu-load"] ?: ""),
            "RAM libera" to (r["free-memory"] ?: ""),
            "Firmware" to (b["current-firmware"] ?: ""),
        ).filterValues { it.isNotBlank() }
    }

    private fun s(id: String, title: String, vararg c: Pair<String, String>) = RosSectionDto(id, title, c.map { RosCommandDto(it.first, it.second) })

    /** Offline fallback; replaced by GET /api/routeros/catalog when online. */
    val FALLBACK_SECTIONS: List<RosSectionDto> = listOf(
        s(
            "quickset", "Quick Set",
            "/system identity print" to "Identità",
            "/system resource print" to "Risorse",
            "/ip address print detail without-paging" to "Indirizzi IP",
            "/ip route print detail without-paging" to "Routing",
            "/interface pppoe-client print detail without-paging" to "PPPoE",
        ),
        s("interfaces", "Interfaces", "/interface print detail without-paging" to "Interfaces"),
        s(
            "wireless", "Wireless",
            "/interface wireless print detail without-paging" to "Wireless v6",
            "/interface wireless registration-table print detail without-paging" to "Registrazioni Wireless",
            "/interface wifi print detail without-paging" to "WiFi RouterOS v7",
        ),
        s(
            "ip", "IP",
            "/ip address print detail without-paging" to "IP Addresses",
            "/ip arp print detail without-paging" to "ARP",
            "/ip dhcp-server lease print detail without-paging" to "DHCP Leases",
            "/ip firewall nat print stats detail without-paging" to "Firewall NAT",
        ),
        s("ppp", "PPP", "/ppp active print detail without-paging" to "PPP Active", "/interface pppoe-client print detail without-paging" to "PPPoE Client"),
        s("system", "System", "/system resource print" to "Resources", "/system routerboard print" to "RouterBOARD", "/system package print without-paging" to "Packages"),
        s("log", "Log", "/log print without-paging" to "Log"),
    )
}
