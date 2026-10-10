package it.cdanet.cpeconfigurator.field

import it.cdanet.cpeconfigurator.data.CpeHealthItemDto

/** The four tiles at the top of Salute CPE: every CPE, online, offline, with a problem. */
enum class HealthState(val label: String, val summary: String) {
    All("Tutte", ""),
    Online("Online", "online"),
    Offline("Offline", "offline"),
    Issues("Problemi", "con problemi"),
    ;

    fun matches(c: CpeHealthItemDto): Boolean = when (this) {
        All -> true
        Online -> c.now?.status == "active"
        // not found in the network: neither online nor offline (a problem of its own)
        Offline -> c.now != null && c.now.status != "active"
        Issues -> c.issues.isNotEmpty()
    }
}

/** One kind of problem (filter panel); the last three come from ISP Billing (admins only). */
enum class HealthProblem(val label: String, val issue: String, val adminOnly: Boolean = false) {
    NotFound("Non trovate in rete", "not_in_uisp"),
    WeakSignal("Segnale debole", "weak_signal"),
    SignalDrop("Segnale calato", "signal_drop"),
    LowCapacity("Capacità bassa", "low_capacity"),
    Ethernet("Porta LAN", "ethernet"),
    Pending("Da accettare", "pending"),
    Firmware("Firmware da aggiornare", "firmware"),
    PppoeOffline("PPPoE offline", "pppoe_offline", adminOnly = true),
    Suspended("Account sospeso", "account_suspended", adminOnly = true),
    Terminated("Cliente cessato", "account_terminated", adminOnly = true),
    ;

    fun matches(c: CpeHealthItemDto): Boolean = issue in c.issues
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
    private val SEVERITY = listOf("offline", "not_in_uisp", "pppoe_offline", "weak_signal", "signal_drop", "ethernet", "low_capacity", "pending", "account_terminated", "account_suspended", "firmware")

    private val HEXISH = Regex("[0-9a-f:.\\-]+")

    private fun macKey(s: String) = s.replace(Regex("[^0-9A-Fa-f]"), "").uppercase()

    /** Customer, MAC (with or without separators), AP, SSID, model, installer, PPPoE user. */
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
    fun apply(list: List<CpeHealthItemDto>, state: HealthState, problem: HealthProblem?, origin: HealthOrigin, query: String): List<CpeHealthItemDto> =
        list.filter { state.matches(it) && (problem == null || problem.matches(it)) && origin.matches(it) && matchesQuery(it, query) }
            .sortedWith(compareBy<CpeHealthItemDto> { c -> c.issues.minOfOrNull { SEVERITY.indexOf(it).takeIf { i -> i >= 0 } ?: SEVERITY.size } ?: Int.MAX_VALUE }.thenBy { it.deviceName.ifBlank { it.mac }.lowercase() })
}
