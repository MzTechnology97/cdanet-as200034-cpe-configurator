package it.cdanet.cpeconfigurator.provisioning

/** Client-side checks mirroring the server schema, for immediate feedback. */
object Validation {
    private val MAC_HEX = Regex("""^[0-9A-Fa-f]{12}$""")
    private val MAC_SEPARATORS = Regex("""[\s:.\-]""")
    // MAC inside scanned text: AA:BB:.., AA-BB-.., AABB.CCDD.EEFF or 12 hex digits.
    private val MAC_IN_TEXT = Regex(
        """(?<![0-9A-Fa-f])(?:(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}|[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}|[0-9A-Fa-f]{12})(?![0-9A-Fa-f])""",
    )
    private val PPPOE = Regex("""^[A-Za-z0-9._-]+@cda-net\.it$""", RegexOption.IGNORE_CASE)

    /**
     * Accepts 24A43C112233, 24:a4:3c:11:22:33, 24-A4-3C-11-22-33, 24a4.3c11.2233 (any case)
     * and returns AA:BB:CC:DD:EE:FF, or null when it is not a MAC.
     */
    fun parseMac(raw: String): String? {
        val hex = raw.trim().replace(MAC_SEPARATORS, "")
        return if (MAC_HEX.matches(hex)) hex.uppercase().chunked(2).joinToString(":") else null
    }

    fun normalizeMac(raw: String): String = parseMac(raw) ?: raw.trim().uppercase()

    fun isMac(raw: String) = parseMac(raw) != null

    fun customerName(user: String): String =
        user.trim().replace(Regex("""@cda-net\.it$""", RegexOption.IGNORE_CASE), "").substringBefore('@')
            .replace(Regex("[._-]+"), " ").replace(Regex("""\s+"""), " ").trim().uppercase()

    fun formErrors(f: ProvisionForm): List<String> = buildList {
        if (!isMac(f.mac)) add("MAC non valido: 12 cifre esadecimali, con o senza separatori")
        if (f.serial.isBlank()) add("Seriale obbligatorio")
        if (!PPPOE.matches(f.pppoeUser.trim())) add("Username RADIUS nel formato cognome.nome@cda-net.it")
        if (f.pppoePassword.isEmpty() && f.replaces == null && f.workOrderId == null) add("Password PPPoE obbligatoria")
    }

    /** Barcode/QR from the CPE label: a MAC (any notation) or the serial. */
    fun applyScan(f: ProvisionForm, value: String): ProvisionForm {
        val v = value.trim()
        val mac = MAC_IN_TEXT.find(v)?.value?.let { parseMac(it) }
        return when {
            mac != null -> f.copy(mac = mac, serial = f.serial.ifBlank { if (MAC_HEX.matches(v)) v.uppercase() else "" })
            else -> f.copy(serial = v.take(128))
        }
    }
}
