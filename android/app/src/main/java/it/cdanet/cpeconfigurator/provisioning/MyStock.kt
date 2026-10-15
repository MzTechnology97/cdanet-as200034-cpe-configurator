package it.cdanet.cpeconfigurator.provisioning

import it.cdanet.cpeconfigurator.data.AppJson
import it.cdanet.cpeconfigurator.data.MyStockDto
import it.cdanet.cpeconfigurator.data.StockItemDto
import it.cdanet.cpeconfigurator.security.SecureStore
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.Serializable
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * The CPEs in the installer's own warehouse, kept on the phone (also without Internet): picked
 * from at step 1 instead of scanning, and used to check a scanned MAC before writing. Saved for
 * one account: another account that logs in on the phone never sees it, nor checks against it.
 */
class MyStock(private val store: SecureStore?) {
    @Serializable
    private data class Saved(val userId: Int, val stock: MyStockDto, val fetchedAt: String)

    private var saved: Saved? = load()
    private var userId: Int? = null
    private val _state = MutableStateFlow<MyStockDto?>(null)
    val state: StateFlow<MyStockDto?> = _state.asStateFlow()

    /** When the phone last read it from the server (null = never, for this account). */
    val fetchedAt: Instant? get() = saved?.takeIf { it.userId == userId }?.let { runCatching { Instant.parse(it.fetchedAt) }.getOrNull() }

    private fun load(): Saved? = runCatching { AppJson.decodeFromString(Saved.serializer(), store?.get(KEY) ?: return null) }.getOrNull()

    /**
     * The account now on the phone (null = logged out). Its own saved warehouse comes back at once,
     * also offline; another account's is thrown away.
     */
    @Synchronized
    fun useAccount(id: Int?) {
        userId = id
        val s = saved
        if (s != null && s.userId != id && id != null) {
            saved = null
            runCatching { store?.remove(KEY) }
        }
        _state.value = saved?.takeIf { id != null && it.userId == id }?.stock
    }

    /** Reads it again from the server (best effort: offline the saved one stays). */
    suspend fun refresh(api: it.cdanet.cpeconfigurator.data.ApiClient) {
        val id = userId ?: return
        val fresh = runCatching { api.myStock() }.getOrNull() ?: return
        // the account changed while it was read: not this one's
        if (userId == id) save(id, fresh)
    }

    /** Keeps [fresh] as the warehouse of the account now on the phone. */
    fun save(fresh: MyStockDto) {
        val id = userId
        if (id == null) _state.value = fresh else save(id, fresh)
    }

    /** Read more than [age] ago (or never): worth reading again. */
    fun olderThan(age: Duration, now: Instant = Instant.now()): Boolean = fetchedAt?.let { Duration.between(it, now) > age } ?: true

    @Synchronized
    private fun save(id: Int, fresh: MyStockDto, at: Instant = Instant.now()) {
        _state.value = fresh
        val s = Saved(id, fresh, at.toString())
        saved = s
        runCatching { store?.put(KEY, AppJson.encodeToString(Saved.serializer(), s)) }
    }

    /**
     * Just installed (also offline): out of the list on the phone at once, so the same CPE does not
     * pass the check again before the next read from the server.
     */
    @Synchronized
    fun installed(mac: String) {
        val id = userId ?: return
        val s = saved?.takeIf { it.userId == id } ?: return
        val m = Validation.parseMac(mac) ?: return
        val left = s.stock.items.filterNot { it.mac.equals(m, ignoreCase = true) }
        if (left.size == s.stock.items.size) return
        save(id, s.stock.copy(items = left), runCatching { Instant.parse(s.fetchedAt) }.getOrDefault(Instant.now()))
    }

    /** The CPE with this MAC in the installer's warehouse, if there. */
    fun find(mac: String): StockItemDto? {
        val m = Validation.parseMac(mac) ?: return null
        return _state.value?.items?.firstOrNull { it.mac.equals(m, ignoreCase = true) }
    }

    /**
     * Why this MAC cannot be installed (null = it can): the account has a warehouse, the CPE is
     * not in it and the account may not skip the check. With the bypass it is only a warning.
     */
    fun problem(mac: String): Problem? {
        val s = _state.value ?: return null
        if (!s.linked || Validation.parseMac(mac) == null || find(mac) != null) return null
        return Problem(
            if (s.bypass) "Questa CPE non risulta nel tuo magazzino: puoi installarla lo stesso, resta annotato."
            else "Questa CPE non risulta nel tuo magazzino: usa una CPE del tuo magazzino o chiedi all'ufficio.",
            blocking = !s.bypass,
        )
    }

    /** «Elenco aggiornato il …» when the list on the phone is old (null = recent enough). */
    fun staleNote(now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): String? =
        staleNote(_state.value?.linked == true, fetchedAt, now, zone)

    data class Problem(val text: String, val blocking: Boolean)

    companion object {
        private const val KEY = "my-stock"

        /** Older than this, step 1 says when the list was read: the office may have changed it since. */
        val STALE: Duration = Duration.ofDays(7)

        private val WHEN = DateTimeFormatter.ofPattern("dd/MM/yyyy 'alle' HH:mm")

        fun staleNote(linked: Boolean, fetchedAt: Instant?, now: Instant, zone: ZoneId): String? {
            if (!linked || fetchedAt == null || Duration.between(fetchedAt, now) < STALE) return null
            return "Elenco del tuo magazzino aggiornato il ${WHEN.format(fetchedAt.atZone(zone))}: collegati a Internet per aggiornarlo, l'ufficio potrebbe averlo cambiato."
        }
    }
}
