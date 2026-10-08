package it.cdanet.cpeconfigurator.provisioning

/** Client-side checks mirroring the server schema, for immediate feedback. */
object Validation {
    private val MAC = Regex("""^(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$""")
    private val MAC_BARE = Regex("""^[0-9A-Fa-f]{12}$""")
    private val PPPOE = Regex("""^[A-Za-z0-9._-]+@cda-net\.it$""", RegexOption.IGNORE_CASE)

    fun normalizeMac(raw: String): String {
        val t = raw.trim()
        if (MAC_BARE.matches(t)) return t.uppercase().chunked(2).joinToString(":")
        return t.replace('-', ':').uppercase()
    }

    fun isMac(raw: String) = MAC.matches(normalizeMac(raw))

    fun customerName(user: String): String =
        user.trim().replace(Regex("""@cda-net\.it$""", RegexOption.IGNORE_CASE), "").substringBefore('@')
            .replace(Regex("[._-]+"), " ").replace(Regex("""\s+"""), " ").trim().uppercase()

    fun formErrors(f: ProvisionForm): List<String> = buildList {
        if (!isMac(f.mac)) add("MAC non valido (AA:BB:CC:DD:EE:FF)")
        if (f.serial.isBlank()) add("Seriale obbligatorio")
        if (!PPPOE.matches(f.pppoeUser.trim())) add("Username RADIUS nel formato cognome.nome@cda-net.it")
        if (f.pppoePassword.isEmpty()) add("Password PPPoE obbligatoria")
    }

    /** Barcode/QR from the CPE label: a MAC (with or without separators) or the serial. */
    fun applyScan(f: ProvisionForm, value: String): ProvisionForm {
        val v = value.trim()
        val mac = Regex("""(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}""").find(v)?.value
            ?: v.takeIf { MAC_BARE.matches(it) }
        return when {
            mac != null -> f.copy(mac = normalizeMac(mac), serial = f.serial.ifBlank { if (MAC_BARE.matches(v)) v.uppercase() else "" })
            else -> f.copy(serial = v.take(128))
        }
    }
}
