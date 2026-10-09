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
import it.cdanet.cpeconfigurator.network.TestTls

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
    "runtime_secret_missing" to "Configurazione del server incompleta: contatta l'amministratore",
    "profile_board_match_missing" to "Profilo senza board match: avvisa un amministratore",
    "job_not_found" to "Provisioning non trovato sul server",
    "job_already_completed" to "Esito già registrato con valore diverso",
    "target_non_privato" to "Consentiti solo target su reti private/CGNAT",
    "template_not_allowed" to "Template non disponibile per il tuo account",
    "uisp_not_configured" to "Servizio non disponibile: contatta l'amministratore",
    "uisp_unreachable" to "Servizio di rete non raggiungibile, riprova più tardi",
    "start_not_found" to "Non trovo ancora il tuo messaggio: apri il bot, premi Avvia e riprova",
    "link_expired" to "Codice scaduto: premi di nuovo Collega Telegram",
    "telegram_not_configured" to "Notifiche Telegram non attive: chiedi all'amministratore",
    "telegram_error" to "Telegram ha rifiutato il messaggio: scrivi prima al bot e controlla l'ID",
    "too_many_zones" to "Hai già 20 zone: eliminane una",
    "zone_not_found" to "Zona non trovata",
    "geocoder_unreachable" to "Servizio indirizzi non raggiungibile",
    "address_too_short" to "Indirizzo troppo corto",
    "pppoe_password_required" to "Password PPPoE necessaria: non è stato possibile recuperarla dal backup della CPE sostituita",
    "replace_same_mac" to "Il MAC è quello della CPE sostituita: inserisci quello della CPE nuova",
    "module_disabled" to "Funzione non disponibile per il tuo account",
    "job_not_completed" to "Esito del provisioning non ancora registrato sul server",
    "too_many_photos" to "Troppe foto per questo job (massimo 8)",
    "photo_not_jpeg" to "La foto deve essere in formato JPEG",
    "mfa_expired" to "Tempo scaduto: ripeti l'accesso",
    "invalid_code" to "Codice non valido",
    "wrong_current_password" to "Password attuale non corretta",
    "password_unchanged" to "La nuova password è uguale a quella attuale",
    "password_contains_username" to "La password non può contenere il nome utente",
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
            TestTls.wrap(http).newCall(b.build()).execute().use { r ->
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

    /** Returns the mfa token when the account uses two-step verification (then call [loginTotp]). */
    suspend fun login(username: String, password: String): String? {
        val body = AppJson.encodeToJsonElement(LoginRequest.serializer(), LoginRequest(username, password))
        val r = AppJson.decodeFromString(LoginStep.serializer(), request("POST", "/api/auth/login", body, auth = false))
        if (r.mfaRequired) return r.mfaToken ?: throw ApiException(500, "mfa_expired", apiMessage("mfa_expired"))
        session.set(SessionState(r.token!!, r.user!!, r.expiresAt!!))
        return null
    }

    /** Second step: 6-digit code from the authenticator app or a recovery code. */
    suspend fun loginTotp(mfaToken: String, code: String) {
        val body = AppJson.encodeToJsonElement(TotpLoginRequest.serializer(), TotpLoginRequest(mfaToken, code.trim()))
        val r = AppJson.decodeFromString(LoginResponse.serializer(), request("POST", "/api/auth/login/totp", body, auth = false))
        session.set(SessionState(r.token, r.user, r.expiresAt))
    }

    /** Own password change: other sessions are revoked, this one continues with the new token. */
    suspend fun changePassword(current: String, new: String) {
        val body = AppJson.encodeToJsonElement(PasswordChangeRequest.serializer(), PasswordChangeRequest(current, new))
        val r = AppJson.decodeFromString(PasswordChangeResponse.serializer(), request("POST", "/api/auth/password", body))
        session.state.value?.let { session.set(it.copy(token = r.token, expiresAt = r.expiresAt)) }
    }

    /** CPE credentials for the field tools (Android client only, audited on the server). */
    suspend fun fieldAccess(purpose: String): it.cdanet.cpeconfigurator.field.FieldAccess {
        val body = buildJsonObject { put("purpose", purpose) }
        return AppJson.decodeFromString(it.cdanet.cpeconfigurator.field.FieldAccess.serializer(), request("POST", "/api/field/access", body, client = true))
    }

    /** WPA2 key of the CDA Net SSID a CPE is being moved to (Android client only, audited). */
    suspend fun relink(ssid: String, cpeMac: String?, from: String?): RelinkDto {
        val body = buildJsonObject { put("ssid", ssid); cpeMac?.let { put("mac", it) }; from?.let { put("from", it.take(64)) } }
        return AppJson.decodeFromString(RelinkDto.serializer(), request("POST", "/api/field/relink", body, client = true))
    }

    /** Installation job of an installed CPE, from its MAC addresses. */
    suspend fun cpeJob(macs: List<String>): JobDto? =
        AppJson.decodeFromString(CpeJobDto.serializer(), request("GET", "/api/field/cpe?macs=" + java.net.URLEncoder.encode(macs.take(8).joinToString(","), "UTF-8"))).job

    suspend fun putAcceptance(jobId: String, report: it.cdanet.cpeconfigurator.field.AcceptanceReport) {
        request("PUT", "/api/provisioning/jobs/$jobId/acceptance", AppJson.encodeToJsonElement(it.cdanet.cpeconfigurator.field.AcceptanceReport.serializer(), report))
    }

    /** Installation photo (JPEG) attached to a job. */
    suspend fun uploadPhoto(jobId: String, jpeg: ByteArray, caption: String) = withContext(Dispatchers.IO) {
        val url = (base() + "/api/provisioning/jobs/$jobId/photos").toHttpUrl().newBuilder().addQueryParameter("caption", caption).build()
        val b = Request.Builder().url(url).post(jpeg.toRequestBody("image/jpeg".toMediaType()))
        session.token?.let { b.header("Authorization", "Bearer $it") }
        TestTls.wrap(http).newCall(b.build()).execute().use { r ->
            if (!r.isSuccessful) {
                val code = runCatching { AppJson.decodeFromString(ApiErrorDto.serializer(), r.body?.string().orEmpty()).error }.getOrNull()?.ifBlank { null } ?: "HTTP ${r.code}"
                throw ApiException(r.code, code, apiMessage(code))
            }
        }
    }

    /** Closes every session of the account (this one included). */
    suspend fun logoutAll() {
        request("POST", "/api/auth/logout-all")
        session.clear()
    }

    suspend fun meta(): MetaDto = AppJson.decodeFromString(MetaDto.serializer(), request("GET", "/api/meta"))

    suspend fun plan(req: ProvisionRequest): PlanDto =
        AppJson.decodeFromString(PlanDto.serializer(), request("POST", "/api/provisioning/plan", AppJson.encodeToJsonElement(ProvisionRequest.serializer(), req)))

    suspend fun createJob(req: ProvisionRequest): ProvisionPackage =
        AppJson.decodeFromString(
            ProvisionPackage.serializer(),
            request("POST", "/api/provisioning/jobs", AppJson.encodeToJsonElement(ProvisionRequest.serializer(), req), client = true),
        )

    suspend fun replaceJob(oldJobId: String, req: ReplaceRequest): ProvisionPackage =
        AppJson.decodeFromString(
            ProvisionPackage.serializer(),
            request("POST", "/api/provisioning/jobs/$oldJobId/replace", AppJson.encodeToJsonElement(ReplaceRequest.serializer(), req), client = true),
        )

    suspend fun outages(): OutagesDto = AppJson.decodeFromString(OutagesDto.serializer(), request("GET", "/api/outages"))

    /** Read-only token for background outage notifications (cannot open a session). */
    suspend fun outageDeviceToken(): String =
        ((AppJson.parseToJsonElement(request("POST", "/api/outages/device-token")) as JsonObject)["token"] as kotlinx.serialization.json.JsonPrimitive).content

    suspend fun reverseGeocode(lat: Double, lon: Double): ReverseGeocodeDto =
        AppJson.decodeFromString(ReverseGeocodeDto.serializer(), request("GET", "/api/geocode/reverse?lat=$lat&lon=$lon"))

    suspend fun myOutageZones(): List<OutageZoneItemDto> = AppJson.decodeFromString(MyZonesDto.serializer(), request("GET", "/api/outages/zones")).zones

    /** Personal area of interest of the user. */
    suspend fun createMyOutageZone(name: String, lat: Double, lon: Double, radiusKm: Double) {
        request("POST", "/api/outages/zones", buildJsonObject { put("name", name); put("lat", lat); put("lon", lon); put("radiusKm", radiusKm) })
    }

    suspend fun deleteMyOutageZone(id: String) {
        request("DELETE", "/api/outages/zones/${id.removePrefix("z")}")
    }

    suspend fun pointing(lat: Double, lon: Double, height: Double?): PointingDto =
        AppJson.decodeFromString(PointingDto.serializer(), request("GET", "/api/pointing?lat=$lat&lon=$lon" + (height?.let { "&height=$it" } ?: "")))

    /** Guasti Enel map data, passed as is to the embedded map page. */
    suspend fun outagesMapJson(): String = request("GET", "/api/outages/map")

    suspend fun networkStatus(): NetworkStatusDto = AppJson.decodeFromString(NetworkStatusDto.serializer(), request("GET", "/api/network/status"))

    suspend fun outageTelegram(): OutageTelegramDto = AppJson.decodeFromString(OutageTelegramDto.serializer(), request("GET", "/api/outages/telegram"))

    suspend fun outageTelegramLink(): TelegramLinkDto = AppJson.decodeFromString(TelegramLinkDto.serializer(), request("POST", "/api/outages/telegram/link"))

    suspend fun outageTelegramVerify(): OutageTelegramDto = AppJson.decodeFromString(OutageTelegramDto.serializer(), request("POST", "/api/outages/telegram/verify"))

    suspend fun outageTelegramSet(chatId: String?, planned: Boolean?): OutageTelegramDto =
        AppJson.decodeFromString(
            OutageTelegramDto.serializer(),
            request("PUT", "/api/outages/telegram", buildJsonObject { chatId?.let { put("chatId", it) }; planned?.let { put("planned", it) } }),
        )

    suspend fun outageTelegramUnlink(): OutageTelegramDto = AppJson.decodeFromString(OutageTelegramDto.serializer(), request("DELETE", "/api/outages/telegram"))

    /** Admin: new area of interest for power outages. */
    suspend fun createOutageZone(name: String, lat: Double, lon: Double, radiusKm: Double) {
        request("POST", "/api/admin/outages/zones", buildJsonObject { put("name", name); put("lat", lat); put("lon", lon); put("radiusKm", radiusKm) })
    }

    suspend fun cpeHealth(): CpeHealthDto = AppJson.decodeFromString(CpeHealthDto.serializer(), request("GET", "/api/cpe-health"))

    suspend fun signalHistory(jobId: String, range: String): SignalHistoryDto =
        AppJson.decodeFromString(SignalHistoryDto.serializer(), request("GET", "/api/provisioning/jobs/$jobId/uisp/statistics?range=$range"))

    suspend fun sendResult(jobId: String, result: ProvisionResult) {
        request("POST", "/api/provisioning/jobs/$jobId/result", AppJson.encodeToJsonElement(ProvisionResult.serializer(), result))
    }

    suspend fun myJobs(): List<JobDto> =
        AppJson.decodeFromString(kotlinx.serialization.builtins.ListSerializer(JobDto.serializer()), request("GET", "/api/provisioning/jobs?limit=100"))

    /** Nearest APs from UISP (server keeps the list to the closest few within range). */
    suspend fun coverage(lat: Double, lon: Double): CoverageDto =
        AppJson.decodeFromString(CoverageDto.serializer(), request("GET", "/api/coverage?lat=$lat&lon=$lon&limit=5"))

    suspend fun geocode(query: String): List<GeocodeResult> =
        AppJson.decodeFromString(
            kotlinx.serialization.builtins.ListSerializer(GeocodeResult.serializer()),
            request("GET", "/api/geocode?q=" + java.net.URLEncoder.encode(query, "UTF-8")),
        )

    /** Named airOS templates (names only) selectable for each model. */
    suspend fun templates(): List<TemplateDto> =
        AppJson.decodeFromString(kotlinx.serialization.builtins.ListSerializer(TemplateDto.serializer()), request("GET", "/api/provisioning/templates"))

    /** SSIDs whose WPA2 key is configured on the server (no secrets). */
    suspend fun wirelessNetworks(): Set<String> =
        AppJson.decodeFromString(kotlinx.serialization.builtins.ListSerializer(WirelessNetworkDto.serializer()), request("GET", "/api/wireless-networks"))
            .map { it.ssid }.toSet()

    suspend fun routerOsCatalog(): RosCatalogDto = AppJson.decodeFromString(RosCatalogDto.serializer(), request("GET", "/api/routeros/catalog"))

    /** Vendors of many MACs at once (IEEE registries on the server); null = unknown. */
    suspend fun macVendors(macs: List<String>): Map<String, String?> {
        if (macs.isEmpty()) return emptyMap()
        val body = buildJsonObject { put("macs", kotlinx.serialization.json.JsonArray(macs.distinct().take(1024).map { kotlinx.serialization.json.JsonPrimitive(it) })) }
        val o = AppJson.parseToJsonElement(request("POST", "/api/tools/mac-vendors", body)) as JsonObject
        return o.mapValues { (_, v) -> (v as? kotlinx.serialization.json.JsonPrimitive)?.takeIf { it.isString }?.content }
    }

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
