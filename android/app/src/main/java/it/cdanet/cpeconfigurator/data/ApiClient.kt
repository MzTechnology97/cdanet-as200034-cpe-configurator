package it.cdanet.cpeconfigurator.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

class ApiException(val status: Int, val code: String, message: String) : IOException(message)

val AppJson = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = true
}

private val ERRORS = mapOf(
    "invalid_credentials" to "Username o password non corretti",
    "too_many_attempts" to "Troppi tentativi: riprova tra qualche minuto",
    "unauthorized" to "Sessione scaduta: accedi di nuovo",
    "forbidden" to "Operazione non consentita",
    "invalid_request" to "Dati non validi",
    "trusted_client_required" to "Client non riconosciuto dal server",
    "client_update_required" to "Aggiorna l'app per continuare",
    "ssid_secret_not_configured" to "Chiave WPA2 non configurata per questo SSID: avvisa un amministratore",
    "provision_profile_missing" to "Profilo airOS mancante per questo modello: avvisa un amministratore",
    "cpe_admin_secret_missing" to "Credenziali CPE non configurate sul server",
    "runtime_secret_missing" to "Segreto runtime mancante sul server (UISP)",
    "profile_board_match_missing" to "Profilo senza board match: avvisa un amministratore",
    "job_not_found" to "Provisioning non trovato sul server",
    "job_already_completed" to "Esito già registrato con valore diverso",
    "target_non_privato" to "Consentiti solo target su reti private/CGNAT",
)

fun apiMessage(code: String): String = ERRORS[code] ?: code

/** Thin JSON client for the CDA Net server. */
class ApiClient(
    private val settings: Settings,
    private val session: Session,
    private val clientHeader: String,
    private val http: OkHttpClient = defaultHttp(),
) {
    private val jsonType = "application/json; charset=utf-8".toMediaType()

    suspend fun base(): String = settings.backendUrlNow()

    suspend fun request(method: String, path: String, body: JsonElement? = null, auth: Boolean = true, client: Boolean = false): String =
        withContext(Dispatchers.IO) {
            val url = (base() + path).toHttpUrl()
            val b = Request.Builder().url(url).header("Accept", "application/json").header("Cache-Control", "no-store")
            if (auth) session.token?.let { b.header("Authorization", "Bearer $it") }
            if (client) b.header("X-CDA-Client", clientHeader)
            b.method(method, body?.toString()?.toRequestBody(jsonType) ?: if (method == "GET") null else "{}".toRequestBody(jsonType))
            http.newCall(b.build()).execute().use { r ->
                val text = r.body?.string().orEmpty()
                if (!r.isSuccessful) {
                    val err = runCatching { AppJson.decodeFromString(ApiErrorDto.serializer(), text) }.getOrNull()
                    val code = err?.error?.ifBlank { null } ?: "HTTP ${r.code}"
                    if (r.code == 401 && auth) session.clear()
                    val detail = err?.minVersion?.let { " (minima $it)" } ?: ""
                    throw ApiException(r.code, code, apiMessage(code) + detail)
                }
                text
            }
        }

    suspend fun health(): HealthDto = AppJson.decodeFromString(HealthDto.serializer(), request("GET", "/api/health", auth = false))

    suspend fun login(username: String, password: String): LoginResponse {
        val body = AppJson.encodeToJsonElement(LoginRequest.serializer(), LoginRequest(username, password))
        val r = AppJson.decodeFromString(LoginResponse.serializer(), request("POST", "/api/auth/login", body, auth = false))
        session.set(SessionState(r.token, r.user, r.expiresAt))
        return r
    }

    suspend fun meta(): MetaDto = AppJson.decodeFromString(MetaDto.serializer(), request("GET", "/api/meta"))

    suspend fun plan(req: ProvisionRequest): PlanDto =
        AppJson.decodeFromString(PlanDto.serializer(), request("POST", "/api/provisioning/plan", AppJson.encodeToJsonElement(ProvisionRequest.serializer(), req)))

    suspend fun createJob(req: ProvisionRequest): ProvisionPackage =
        AppJson.decodeFromString(
            ProvisionPackage.serializer(),
            request("POST", "/api/provisioning/jobs", AppJson.encodeToJsonElement(ProvisionRequest.serializer(), req), client = true),
        )

    suspend fun sendResult(jobId: String, result: ProvisionResult) {
        request("POST", "/api/provisioning/jobs/$jobId/result", AppJson.encodeToJsonElement(ProvisionResult.serializer(), result))
    }

    suspend fun myJobs(): List<JobDto> =
        AppJson.decodeFromString(kotlinx.serialization.builtins.ListSerializer(JobDto.serializer()), request("GET", "/api/provisioning/jobs?limit=100"))

    suspend fun routerOsCatalog(): RosCatalogDto = AppJson.decodeFromString(RosCatalogDto.serializer(), request("GET", "/api/routeros/catalog"))

    suspend fun macVendor(mac: String): String {
        val r = request("POST", "/api/tools/mac-vendor", buildJsonObject { put("mac", mac) })
        return (AppJson.parseToJsonElement(r) as JsonObject)["vendor"]?.toString()?.trim('"') ?: "—"
    }

    companion object {
        fun defaultHttp(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(8, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .writeTimeout(20, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build()
    }
}
