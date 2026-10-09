package it.cdanet.cpeconfigurator.provisioning

import it.cdanet.cpeconfigurator.data.ChecksDto
import it.cdanet.cpeconfigurator.data.DetectedDto
import java.security.MessageDigest

/** Pure verification logic, unit-tested on the JVM. */
object DeviceCheck {
    const val READBACK_COMMAND =
        "echo __VERSION__; cat /etc/version 2>/dev/null; echo __BOARD__; cat /etc/board.info 2>/dev/null; " +
            "echo __SYSTEM__; cat /proc/ubnthal/system.info 2>/dev/null; true"

    const val COMMIT_COMMAND = "cfgmtd -f /tmp/system.cfg -w -p /etc/ && sync"

    data class Readback(val raw: String, val firmware: String?, val board: String?, val macs: Set<String>) {
        fun detected() = DetectedDto(firmware = firmware, board = board, mac = macs.firstOrNull()?.let { formatMac(it) })
    }

    fun parse(raw: String): Readback {
        val version = section(raw, "__VERSION__", "__BOARD__").lineSequence().map { it.trim() }.firstOrNull { it.isNotEmpty() }
        val keyValues = (section(raw, "__BOARD__", "__SYSTEM__") + "\n" + section(raw, "__SYSTEM__", null))
            .lineSequence()
            .mapNotNull { line -> line.indexOf('=').takeIf { it > 0 }?.let { line.substring(0, it).trim() to line.substring(it + 1).trim() } }
            .toList()
        val board = keyValues.firstOrNull { it.first == "board.name" }?.second
            ?: keyValues.firstOrNull { it.first == "board.shortname" }?.second
        val macs = keyValues
            .filter { it.first in setOf("board.hwaddr", "eth0.macaddr", "ath0.macaddr", "wifi0.macaddr", "serialno") }
            .mapNotNull { normalizeMac(it.second) }
            .toSet()
        return Readback(raw, version, board, macs)
    }

    private fun section(raw: String, start: String, end: String?): String {
        val i = raw.indexOf(start).takeIf { it >= 0 } ?: return ""
        val from = i + start.length
        val j = end?.let { raw.indexOf(it, from) }?.takeIf { it >= 0 } ?: raw.length
        return raw.substring(from, j)
    }

    fun normalizeMac(value: String): String? {
        val hex = value.filter { it.isLetterOrDigit() }.lowercase()
        return hex.takeIf { it.length == 12 && it.all { c -> c in '0'..'9' || c in 'a'..'f' } }
    }

    fun formatMac(hex: String) = hex.uppercase().chunked(2).joinToString(":")

    /** Firmware string like `XC.qca956x.v8.7.4.45112.210415.1103` must be exactly 8.7.4. */
    fun firmwareMatches(version: String?, target: String): Boolean {
        if (version == null) return false
        val rx = Regex("""(?:^|[^0-9.])v?${Regex.escape(target)}(?![0-9])""")
        return rx.containsMatchIn(version)
    }

    /** Throws an Italian, user-facing message when the CPE is not the expected one. */
    fun verify(rb: Readback, checks: ChecksDto) {
        if (!firmwareMatches(rb.firmware, checks.firmware)) {
            throw IllegalStateException(
                "Firmware rilevato ${rb.firmware ?: "sconosciuto"}: è richiesto ${checks.firmware}. Scrittura bloccata: aggiorna prima la CPE da CPE collegata → Firmware.",
            )
        }
        if (checks.boardMatch.isBlank()) throw IllegalStateException("Profilo senza board match: scrittura bloccata")
        val rx = runCatching { Regex(checks.boardMatch, setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL)) }
            .getOrElse { throw IllegalStateException("Board match del profilo non valido") }
        if (!rx.containsMatchIn(rb.raw)) {
            throw IllegalStateException("La board rilevata (${rb.board ?: "sconosciuta"}) non corrisponde al profilo del modello selezionato")
        }
        val expected = normalizeMac(checks.mac) ?: throw IllegalStateException("MAC atteso non valido")
        if (expected !in rb.macs) {
            throw IllegalStateException(
                "MAC della CPE (${rb.macs.joinToString { formatMac(it) }.ifBlank { "non leggibile" }}) diverso da quello indicato ${formatMac(expected)}",
            )
        }
    }

    fun sha256Hex(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    fun md5Hex(bytes: ByteArray): String = MessageDigest.getInstance("MD5").digest(bytes).joinToString("") { "%02x".format(it) }
}
