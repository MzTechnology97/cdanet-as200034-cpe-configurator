package it.cdanet.cpeconfigurator.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.net.URLEncoder

/**
 * Saved coverage checks (Verifica copertura): a name written (installers) or a customer of ISP
 * Billing (admins), the point, how it was checked and what it said then. The server runs the check
 * again when it is saved and keeps its answer; «Apri» checks the same point again the same way.
 */

@Serializable
data class SavedCheckCustomerDto(val id: String = "", val name: String = "", val code: String = "")

@Serializable
data class SavedCheckPointDto(val lat: Double = 0.0, val lon: Double = 0.0, val label: String = "")

@Serializable
data class SavedCheckParamsDto(val cpe: String? = null, val height: Double? = null, val km: Double? = null, val limit: Int? = null)

@Serializable
data class SavedCheckBestDto(val name: String = "", val rating: String = "", val distanceM: Double? = null, val signalDbm: Double? = null, val eveningMbps: Double? = null)

/** What the check said when it was saved (coverage: the best AP; feasibility: ours and the others). */
@Serializable
data class SavedCheckSummaryDto(
    val kind: String = "coverage",
    val verdict: String = "",
    val title: String = "",
    val best: SavedCheckBestDto? = null,
    val aps: Int = 0,
    val others: String? = null,
    val eveningMbps: Double? = null,
    val sticker: String? = null,
) {
    /** «Copertura probabile: N20-D06 · 2,4 km · −61 dBm stimati · altri operatori: F» */
    fun describe(): String {
        val other = others?.let { "altri operatori: $it" }
        if (kind == "feasibility") return listOfNotNull(title, eveningMbps?.let { "la sera ~${Math.round(it)} Mbit/s" }, sticker?.let { "bollino $it" }, other).joinToString(" · ")
        val b = best ?: return listOfNotNull(title, other).joinToString(" · ")
        return listOfNotNull(
            "$title: ${b.name}",
            b.distanceM?.let { d -> if (d < 1000) "${Math.round(d)} m" else String.format(java.util.Locale.ITALY, "%.1f km", d / 1000) },
            b.signalDbm?.let { "${Math.round(it)} dBm stimati" },
            b.eveningMbps?.let { "la sera ~${Math.round(it)} Mbit/s" },
            other,
        ).joinToString(" · ")
    }
}

@Serializable
data class SavedCheckDto(
    val id: Long = 0,
    val kind: String = "coverage",
    val name: String = "",
    val customer: SavedCheckCustomerDto? = null,
    val point: SavedCheckPointDto = SavedCheckPointDto(),
    val params: SavedCheckParamsDto = SavedCheckParamsDto(),
    val summary: SavedCheckSummaryDto? = null,
    val by: String = "",
    val mine: Boolean = true,
    val createdAt: String = "",
    val updatedAt: String = "",
)

@Serializable
data class SavedChecksDto(val total: Int = 0, val items: List<SavedCheckDto> = emptyList())

/** A customer of ISP Billing to name a check after (admins only). */
@Serializable
data class CheckCustomerDto(val customerId: String = "", val name: String = "", val code: String = "", val address: String = "", val distanceM: Double? = null)

@Serializable
data class CheckCustomersDto(val configured: Boolean = false, val near: List<CheckCustomerDto> = emptyList(), val found: List<CheckCustomerDto> = emptyList())

private fun enc(v: String) = URLEncoder.encode(v, "UTF-8")

/** The saved checks of [kind]: the user's own; admins every one unless [mine]. */
suspend fun ApiClient.savedChecks(kind: String = "coverage", mine: Boolean = false, q: String = "", limit: Int = 50): SavedChecksDto =
    AppJson.decodeFromString(
        SavedChecksDto.serializer(),
        request("GET", "/api/saved-checks?kind=$kind&limit=$limit" + (if (mine) "&mine=1" else "") + (if (q.isNotBlank()) "&q=" + enc(q.trim()) else "")),
    )

/** Saves the check of a point with a name (or a customer of ISP Billing, admins): the server runs it again. */
suspend fun ApiClient.saveCheck(
    kind: String,
    name: String,
    lat: Double,
    lon: Double,
    label: String,
    customerId: String? = null,
    heightM: Double? = null,
    cpe: String? = null,
    limit: Int? = null,
    km: Int? = null,
): SavedCheckDto =
    AppJson.decodeFromString(
        SavedCheckDto.serializer(),
        request("POST", "/api/saved-checks", buildJsonObject {
            put("kind", kind)
            put("name", name.take(120))
            put("lat", lat)
            put("lon", lon)
            put("label", label.take(200))
            customerId?.let { put("customerId", it) }
            put("params", buildJsonObject {
                if (kind == "coverage") {
                    heightM?.let { put("height", it) }
                    cpe?.let { put("cpe", it) }
                    limit?.let { put("limit", it) }
                    km?.let { put("km", it) }
                }
            })
        }),
    )

/** A new name; [customer]: unchanged when null, a customer's id to link it, "" to unlink it. */
suspend fun ApiClient.renameCheck(id: Long, name: String, customer: String? = null): SavedCheckDto =
    AppJson.decodeFromString(
        SavedCheckDto.serializer(),
        request("PATCH", "/api/saved-checks/$id", buildJsonObject {
            put("name", name.take(120))
            when {
                customer == null -> Unit
                customer.isEmpty() -> put("customerId", JsonNull)
                else -> put("customerId", customer)
            }
        }),
    )

suspend fun ApiClient.deleteCheck(id: Long) {
    request("DELETE", "/api/saved-checks/$id")
}

/** Admins: customers of ISP Billing with a site near the point, and those matching [q]. */
suspend fun ApiClient.checkCustomers(lat: Double? = null, lon: Double? = null, q: String = ""): CheckCustomersDto =
    AppJson.decodeFromString(
        CheckCustomersDto.serializer(),
        request("GET", "/api/admin/saved-checks/customers?" + listOfNotNull(
            if (lat != null && lon != null) "lat=$lat&lon=$lon" else null,
            q.trim().takeIf { it.length >= 2 }?.let { "q=" + enc(it) },
        ).joinToString("&")),
    )
