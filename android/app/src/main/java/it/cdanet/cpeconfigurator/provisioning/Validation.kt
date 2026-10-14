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

    /** A MAC a device can have: unicast (first byte even) and not all zeros; e.g. 81:78:… is another code of the box. */
    fun isDeviceMac(raw: String): Boolean {
        val hex = parseMac(raw)?.replace(":", "") ?: return false
        return hex.substring(0, 2).toInt(16) and 1 == 0 && hex.any { it != '0' }
    }

    fun customerName(user: String): String =
        user.trim().replace(Regex("""@cda-net\.it$""", RegexOption.IGNORE_CASE), "").substringBefore('@')
            .replace(Regex("[._-]+"), " ").replace(Regex("""\s+"""), " ").trim().uppercase()

    fun formErrors(f: ProvisionForm): List<String> = buildList {
        if (!isMac(f.mac)) add("MAC non valido: 12 cifre esadecimali, con o senza separatori")
        else if (!isDeviceMac(f.mac)) add("Questo non è il MAC di un apparato (il primo numero è dispari): scansiona il codice «MAC» dell'etichetta o usa «Rileva il modello dalla CPE»")
        if (f.serial.isBlank()) add("Seriale obbligatorio")
        else if (serialLooksLikeMac(f.serial)) add("Nel campo Seriale c'è un MAC: va nel campo MAC, nel Seriale il numero di serie (S/N) dell'etichetta")
        if (!PPPOE.matches(f.pppoeUser.trim())) add("Username RADIUS nel formato cognome.nome@cda-net.it")
        if (f.pppoePassword.isEmpty() && f.replaces == null && f.workOrderId == null) add("Password PPPoE obbligatoria")
    }

    /**
     * Model of the configurator from what the CPE announces (Ubiquiti discovery: "LBE-5AC-Gen2",
     * "LiteBeam 5AC Gen2", "Loco5AC"…); null when it is not one of the supported models. Pure.
     */
    fun modelFromDiscovery(model: String?, fullModel: String?): String? {
        val t = listOfNotNull(fullModel, model).joinToString(" ").lowercase().replace("-", " ")
        val words = t.split(Regex("[^a-z0-9]+")).toSet()
        return when {
            "litebeam" in t || "lbe" in words -> "LiteBeam 5AC"
            "loco" in t -> "NanoStation Loco 5AC"
            "nanobeam" in t || "nbe" in words -> "NanoBeam 5AC"
            "powerbeam" in t || "pbe" in words -> "PowerBeam 5AC"
            "nanostation" in t || "ns 5ac" in t -> "NanoStation 5AC"
            else -> null
        }
    }

    /**
     * Barcode/QR from the CPE label: a MAC (any notation) or the serial. A code that looks like a
     * MAC but cannot be one of a device (e.g. 81:78:… from the box) changes nothing: see [scanProblem].
     */
    fun applyScan(f: ProvisionForm, value: String): ProvisionForm {
        val v = value.trim()
        val candidates = MAC_IN_TEXT.findAll(v).mapNotNull { parseMac(it.value) }.toList()
        val mac = candidates.firstOrNull { isDeviceMac(it) }
        return when {
            mac != null -> f.copy(mac = mac, serial = f.serial.ifBlank { if (MAC_HEX.matches(v)) v.uppercase() else "" })
            candidates.isNotEmpty() -> f
            else -> f.copy(serial = v.take(128))
        }
    }

    /** A MAC written with separators (AA:BB:… or AA-BB-…) in the serial field: the two fields were swapped. */
    fun serialLooksLikeMac(serial: String): Boolean {
        val v = serial.trim()
        return (v.contains(':') || v.contains('-')) && parseMac(v)?.let { isDeviceMac(it) } == true
    }

    /**
     * On Ubiquiti CPEs the serial is usually the MAC (12 hex digits): two different device MACs in
     * the two fields mean one of them comes from another code of the box. A warning, not an error.
     */
    fun serialMacMismatch(f: ProvisionForm): String? {
        val mac = parseMac(f.mac) ?: return null
        val serialMac = parseMac(f.serial)?.takeIf { MAC_HEX.matches(f.serial.trim()) && isDeviceMac(it) } ?: return null
        return if (serialMac != mac) "Sulle CPE Ubiquiti seriale e MAC di solito coincidono: controlla di non aver scambiato i due codici dell'etichetta." else null
    }

    /**
     * The scan button of the MAC field: the device MAC in the code (any notation), or why the code
     * is not one (another code of the box, or no MAC at all).
     */
    fun scanMac(raw: String): Pair<String?, String?> {
        val candidates = MAC_IN_TEXT.findAll(raw.trim()).mapNotNull { parseMac(it.value) }.toList()
        candidates.firstOrNull { isDeviceMac(it) }?.let { return it to null }
        return null to (scanProblem(raw) ?: "Il codice letto non contiene un MAC: inquadra il codice «MAC» sull'etichetta della CPE.")
    }

    /** The scan button of the serial field: the code as it is, with a warning when it is a MAC with separators. */
    fun scanSerial(raw: String): Pair<String, String?> {
        val v = raw.trim().take(128)
        return v to (if (serialLooksLikeMac(v)) "Hai inquadrato il MAC: per il seriale usa il codice «S/N» dell'etichetta." else null)
    }

    /** Why a scanned code was not used: it looks like a MAC but no device can have it. */
    fun scanProblem(value: String): String? {
        val candidates = MAC_IN_TEXT.findAll(value.trim()).mapNotNull { parseMac(it.value) }.toList()
        if (candidates.isEmpty() || candidates.any { isDeviceMac(it) }) return null
        return "Il codice letto (${candidates.first()}) non è il MAC di un apparato: inquadra il codice «MAC» sull'etichetta della CPE, non altri codici della scatola."
    }
}
