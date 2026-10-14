package it.cdanet.cpeconfigurator.provisioning

import it.cdanet.cpeconfigurator.data.AppJson
import it.cdanet.cpeconfigurator.data.MyStockDto
import it.cdanet.cpeconfigurator.data.StockItemDto
import it.cdanet.cpeconfigurator.security.SecureStore
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * The CPEs in the installer's own warehouse, kept on the phone (also without Internet): picked
 * from at step 1 instead of scanning, and used to check a scanned MAC before writing.
 */
class MyStock(private val store: SecureStore?) {
    private val _state = MutableStateFlow(load())
    val state: StateFlow<MyStockDto?> = _state.asStateFlow()

    private fun load(): MyStockDto? = runCatching { AppJson.decodeFromString(MyStockDto.serializer(), store?.get(KEY) ?: return null) }.getOrNull()

    /** Reads it again from the server (best effort: offline the saved one stays). */
    suspend fun refresh(api: it.cdanet.cpeconfigurator.data.ApiClient) {
        save(runCatching { api.myStock() }.getOrNull() ?: return)
    }

    /** Keeps [fresh] as the warehouse on the phone. */
    fun save(fresh: MyStockDto) {
        _state.value = fresh
        runCatching { store?.put(KEY, AppJson.encodeToString(MyStockDto.serializer(), fresh)) }
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

    data class Problem(val text: String, val blocking: Boolean)

    companion object {
        private const val KEY = "my-stock"
    }
}
