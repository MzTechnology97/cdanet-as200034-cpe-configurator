package it.cdanet.cpeconfigurator.provisioning

import it.cdanet.cpeconfigurator.data.AppJson
import it.cdanet.cpeconfigurator.data.ProvisionPackage
import it.cdanet.cpeconfigurator.security.SecureStore
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import java.time.Instant

/**
 * The configurations prepared before the visit, one per work order, kept encrypted on the phone
 * (like the package being written) until they are used or expire: on a roof without Internet the
 * installation of an assigned order starts from here. Never shown: only written to the CPE.
 */
class FieldPackages(private val store: SecureStore?) {
    private val serializer = MapSerializer(Long.serializer(), ProvisionPackage.serializer())
    private var map: Map<Long, ProvisionPackage> = load()
    private val _ready = MutableStateFlow(map.keys)

    /** Work orders with a configuration ready for the field. */
    val ready: StateFlow<Set<Long>> = _ready.asStateFlow()

    private fun valid(p: ProvisionPackage) = runCatching { Instant.parse(p.expiresAt).isAfter(Instant.now()) }.getOrDefault(false)

    private fun load(): Map<Long, ProvisionPackage> {
        val s = store ?: return emptyMap()
        val all = runCatching { AppJson.decodeFromString(serializer, s.get(KEY) ?: return emptyMap()) }.getOrNull() ?: return emptyMap()
        return all.filterValues { valid(it) }
    }

    @Synchronized
    private fun save(m: Map<Long, ProvisionPackage>) {
        map = m.filterValues { valid(it) }
        _ready.value = map.keys
        val s = store ?: return
        runCatching { if (map.isEmpty()) s.remove(KEY) else s.put(KEY, AppJson.encodeToString(serializer, map)) }
    }

    /** The order's configuration when still valid. */
    fun get(orderId: Long): ProvisionPackage? = map[orderId]?.takeIf { valid(it) }

    /** Still valid: it is not prepared again (a new one only after it expires, never a job per app start). */
    fun fresh(orderId: Long): Boolean = get(orderId) != null

    fun put(orderId: Long, pkg: ProvisionPackage) = save(map + (orderId to pkg))

    fun remove(orderId: Long) = save(map - orderId)

    /** Expired ones go away (also when they were never used). */
    fun prune() = save(map)

    companion object {
        private const val KEY = "field-packages"
    }
}
