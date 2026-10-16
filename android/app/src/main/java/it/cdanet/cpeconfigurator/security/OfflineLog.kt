package it.cdanet.cpeconfigurator.security

import it.cdanet.cpeconfigurator.data.ApiClient
import it.cdanet.cpeconfigurator.data.AppJson
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import java.time.Instant

/**
 * What the account did with the session kept on the phone, without Internet (session taken back,
 * CPE tools used): kept encrypted on the phone and sent to the server's activity log at the next
 * contact, with the time it happened.
 */
class OfflineLog(private val store: SecureStore) {
    @Serializable
    data class Entry(val at: String, val action: String, val target: String = "", val detail: String = "")

    private val serializer = ListSerializer(Entry.serializer())

    private fun read(): List<Entry> = runCatching { store.get(NAME)?.let { AppJson.decodeFromString(serializer, it) } }.getOrNull().orEmpty()

    @Synchronized
    fun record(action: String, target: String = "", detail: String = "") {
        // the most recent 200 at most: the server takes no more in one go
        val next = (read() + Entry(Instant.now().toString(), action, target.take(80), detail.take(200))).takeLast(200)
        runCatching { store.put(NAME, AppJson.encodeToString(serializer, next)) }
    }

    /** To the server's activity log; kept on the phone when it cannot be sent. */
    suspend fun send(api: ApiClient) {
        val list = synchronized(this) { read() }
        if (list.isEmpty()) return
        runCatching { api.offlineEvents(list) }.onSuccess {
            synchronized(this) {
                // what was recorded while sending stays for the next time
                val now = read()
                if (now.size <= list.size) store.remove(NAME) else store.put(NAME, AppJson.encodeToString(serializer, now.drop(list.size)))
            }
        }
    }

    fun clear() = store.remove(NAME)

    private companion object {
        const val NAME = "offline_log"
    }
}
