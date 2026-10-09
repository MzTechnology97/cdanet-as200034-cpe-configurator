package it.cdanet.cpeconfigurator.field

import it.cdanet.cpeconfigurator.data.CpeHealthItemDto

/** "Mostra": same choices as the web console (Salute CPE). */
enum class HealthShow(val label: String, private val issues: Set<String>?) {
    Issues("Con problemi", null),
    All("Tutte", emptySet()),
    Offline("Offline", setOf("offline", "not_in_uisp")),
    Signal("Segnale", setOf("weak_signal", "signal_drop", "low_capacity")),
    Ethernet("Porta LAN", setOf("ethernet")),
    Pending("In attesa", setOf("pending")),
    Firmware("Firmware", setOf("firmware")),
    ;

    fun matches(c: CpeHealthItemDto): Boolean = when {
        issues == null -> c.issues.isNotEmpty()
        issues.isEmpty() -> true
        else -> c.issues.any { it in issues }
    }
}

/** "Origine": installed with the app, found in the network only, assigned or not (admin). */
enum class HealthOrigin(val label: String, val installerLabel: String, val adminOnly: Boolean = false) {
    All("Tutte", "Tutte"),
    App("Installate con l'app", "Installate da me"),
    Network("Solo in UISP", "Assegnate a me"),
    Assigned("Assegnate a un installatore", "", adminOnly = true),
    Unassigned("Non assegnate", "", adminOnly = true),
    ;

    fun matches(c: CpeHealthItemDto): Boolean = when (this) {
        All -> true
        App -> c.source == "app"
        Network -> c.source != "app"
        Assigned -> c.assignedTo != null
        Unassigned -> c.assignedTo == null
    }
}

/** Search, filters and order of the CPE list. Pure, unit-tested. */
object HealthFilter {
    private val SEVERITY = listOf("offline", "not_in_uisp", "weak_signal", "signal_drop", "ethernet", "low_capacity", "pending", "firmware")

    private val HEXISH = Regex("[0-9a-f:.\\-]+")

    private fun macKey(s: String) =s.replace(Regex("[^0-9A-Fa-f]"), "").uppercase()

    /** Customer, MAC (with or without separators), AP, SSID, model, installer. */
    fun matchesQuery(c: CpeHealthItemDto, query: String): Boolean {
        val q = query.trim().lowercase()
        if (q.isEmpty()) return true
        val words = q.split(Regex("\\s+"))
        val text = listOf(c.deviceName, c.mac, c.ssid, c.model, c.now?.apName.orEmpty(), c.installer, c.assignedTo?.username.orEmpty()).joinToString(" ").lowercase()
        val mac = macKey(c.mac)
        // a MAC fragment matches with any separators: "2233" finds 11:22:33:44:55:66
        return words.all { w -> text.contains(w) || (HEXISH.matches(w) && macKey(w).length >= 4 && mac.contains(macKey(w))) }
    }

    /** Most serious problems first, then by name. */
    fun apply(list: List<CpeHealthItemDto>, show: HealthShow, origin: HealthOrigin, query: String): List<CpeHealthItemDto> =
        list.filter { show.matches(it) && origin.matches(it) && matchesQuery(it, query) }
            .sortedWith(compareBy<CpeHealthItemDto> { c -> c.issues.minOfOrNull { SEVERITY.indexOf(it).takeIf { i -> i >= 0 } ?: SEVERITY.size } ?: Int.MAX_VALUE }.thenBy { it.deviceName.ifBlank { it.mac }.lowercase() })
}
