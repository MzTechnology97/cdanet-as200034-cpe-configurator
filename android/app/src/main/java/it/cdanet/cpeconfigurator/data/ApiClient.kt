package it.cdanet.cpeconfigurator.data

import kotlinx.serialization.json.doubleOrNull
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.jsonObject
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
    "device_revoked" to "Accesso rapido non più valido su questo telefono: accedi con la password",
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
    "dem_not_configured" to "Modello del terreno non configurato sul server",
    "dem_unavailable" to "Modello del terreno non disponibile in questa zona",
    "ap_not_found" to "AP non trovato tra quelli vicini",
    "work_order_not_found" to "Intervento non trovato",
    "work_order_closed" to "Intervento già chiuso o annullato",
    "work_order_password_missing" to "L'intervento non ha la password PPPoE: chiedila all'ufficio",
    "too_many_zones" to "Hai già 20 zone: eliminane una",
    "zone_not_found" to "Zona non trovata",
    "geocoder_unreachable" to "Servizio indirizzi non raggiungibile",
    "address_too_short" to "Indirizzo troppo corto",
    "pppoe_password_required" to "Password PPPoE necessaria: non è stato possibile recuperarla dal backup della CPE sostituita",
    "replace_same_mac" to "Il MAC è quello della CPE sostituita: inserisci quello della CPE nuova",
    "module_disabled" to "Funzione non disponibile per il tuo account",
    "job_not_completed" to "Esito del provisioning non ancora registrato sul server",
    "acceptance_position_mismatch" to "Collaudo rifiutato: sei a più di 500 m dalla posizione dell'intervento. Verifica il cliente o fai correggere l'indirizzo all'ufficio.",
    "too_many_photos" to "Troppe foto per questo job (massimo 8)",
    "photo_not_jpeg" to "La foto deve essere in formato JPEG",
    "device_revoked" to "Accesso del telefono revocato (password cambiata, account disattivato o uscita da tutti i dispositivi): accedi con la password",
    "device_expired" to "Sessione scaduta: accedi di nuovo con la password",
    "privacy_changed" to "L'informativa è cambiata nel frattempo: rileggila",
    "privacy_not_configured" to "Informativa non ancora disponibile",
    "firmware_not_found" to "Firmware non più disponibile sul server: aggiorna l'elenco",
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

    /** Set when the server refuses this app version (426): the app then blocks until updated. */
    val updateRequired = kotlinx.coroutines.flow.MutableStateFlow<String?>(null)

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
                    if (r.code == 426) updateRequired.value = err?.minVersion ?: "nuova"
                    val detail = err?.minVersion?.let { " (minima $it)" } ?: ""
                    throw ApiException(r.code, code, apiMessage(code) + detail)
                }
                text
            }
        }

    /**
     * Plain GET of a page or file of our server for the embedded map (no session), with the same
     * certificate trust as the API: WebView's own TLS would reject a self-signed test server.
     * Blocking: called on WebView's request thread. The caller closes the response.
     */
    fun fetchForWebView(url: String, headers: Map<String, String>): okhttp3.Response {
        val b = Request.Builder().url(url)
        // only what a static page needs: byte ranges (PMTiles) and content negotiation
        headers.filterKeys { it.equals("Range", true) || it.equals("Accept", true) || it.equals("If-Range", true) }.forEach { (k, v) -> b.header(k, v) }
        return TestTls.wrap(http).newCall(b.build()).execute()
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

    /** Login with the key of this phone (persistent, or unlocked by fingerprint or face); returns its new expiry. */
    suspend fun deviceLogin(id: String, secret: String): String? {
        val body = buildJsonObject { put("id", id); put("secret", secret) }
        val r = AppJson.decodeFromString(LoginResponse.serializer(), request("POST", "/api/auth/device-login", body, auth = false, client = true))
        session.set(SessionState(r.token, r.user, r.expiresAt))
        return r.deviceExpiresAt
    }

    /** Registers this phone for the quick login (after a full login). */
    suspend fun registerDevice(name: String, persistent: Boolean = false): DeviceKeyDto =
        AppJson.decodeFromString(
            DeviceKeyDto.serializer(),
            request("POST", "/api/auth/devices", buildJsonObject { put("name", name.take(60)); if (persistent) put("persistent", true) }, client = true),
        )

    suspend fun removeDevice(id: String) {
        request("DELETE", "/api/auth/devices/$id")
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

    /** Installation postponed or KO (reason always written by the technician). */
    suspend fun reportKo(req: KoRequest): Long =
        AppJson.decodeFromString(KoCreatedDto.serializer(), request("POST", "/api/installs/ko", AppJson.encodeToJsonElement(KoRequest.serializer(), req))).id

    suspend fun notifications(): NotificationsDto = AppJson.decodeFromString(NotificationsDto.serializer(), request("GET", "/api/notifications?limit=100"))

    suspend fun unreadNotifications(): Int = AppJson.decodeFromString(UnreadDto.serializer(), request("GET", "/api/notifications/count")).unread

    suspend fun markNotificationsRead(ids: List<Long>? = null) {
        val body = if (ids == null) buildJsonObject { put("all", true) } else buildJsonObject { put("ids", kotlinx.serialization.json.JsonArray(ids.map { kotlinx.serialization.json.JsonPrimitive(it) })) }
        request("POST", "/api/notifications/read", body)
    }

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

    suspend fun workOrders(): WorkOrdersDto = AppJson.decodeFromString(WorkOrdersDto.serializer(), request("GET", "/api/work-orders"))

    suspend fun setWorkOrderStatus(id: Long, status: String, note: String = "") {
        request("POST", "/api/work-orders/$id/status", buildJsonObject { put("status", status); put("note", note) })
    }

    suspend fun myOutageZones(): MyZonesDto = AppJson.decodeFromString(MyZonesDto.serializer(), request("GET", "/api/outages/zones"))

    /** Personal area of interest of the user. */
    suspend fun createMyOutageZone(name: String, lat: Double, lon: Double, radiusKm: Double, notifyMt: Boolean = true, notifyBt: Boolean = true, notifyPlanned: Boolean = false) {
        request("POST", "/api/outages/zones", buildJsonObject {
            put("name", name); put("lat", lat); put("lon", lon); put("radiusKm", radiusKm)
            put("notifyMt", notifyMt); put("notifyBt", notifyBt); put("notifyPlanned", notifyPlanned)
        })
    }

    /** Changes the rules (paused, notifyMt, notifyBt, notifyPlanned) or the radius/name of a personal area. */
    suspend fun updateMyOutageZone(id: String, patch: kotlinx.serialization.json.JsonObject) {
        request("PUT", "/api/outages/zones/${id.removePrefix("z")}", patch)
    }

    suspend fun deleteMyOutageZone(id: String) {
        request("DELETE", "/api/outages/zones/${id.removePrefix("z")}")
    }

    suspend fun lineOfSight(lat: Double, lon: Double, apId: String, height: Double?): LosDto =
        AppJson.decodeFromString(LosDto.serializer(), request("GET", "/api/pointing/profile?lat=$lat&lon=$lon&apId=${java.net.URLEncoder.encode(apId, "UTF-8")}" + (height?.let { "&height=$it" } ?: "")))

    suspend fun privacy(): PrivacyDto = AppJson.decodeFromString(PrivacyDto.serializer(), request("GET", "/api/privacy"))

    suspend fun acceptPrivacy(sha256: String, device: String) {
        request("POST", "/api/privacy/accept", buildJsonObject { put("sha256", sha256); put("device", device.take(120)) }, client = true)
    }

    /** Read-only token of the background worker (notifications and the next work orders). */
    suspend fun notificationsDeviceToken(): String =
        AppJson.parseToJsonElement(request("POST", "/api/notifications/device-token")).jsonObject["token"]!!.jsonPrimitive.content

    suspend fun checkWorkOrderPosition(id: Long, lat: Double, lon: Double, accuracyM: Double?): PositionCheckDto =
        AppJson.decodeFromString(
            PositionCheckDto.serializer(),
            request("POST", "/api/work-orders/$id/position", buildJsonObject { put("lat", lat); put("lon", lon); accuracyM?.let { put("accuracyM", it) } }),
        )

    suspend fun firmwareList(): FirmwareListDto = AppJson.decodeFromString(FirmwareListDto.serializer(), request("GET", "/api/firmware"))

    /** Streams a firmware image into [dest]; [onBytes] gets the bytes received so far. */
    suspend fun firmwareDownload(id: Int, dest: java.io.File, onBytes: (Long) -> Unit) = withContext(Dispatchers.IO) {
        val b = Request.Builder().url((base() + "/api/firmware/$id/file").toHttpUrl())
        session.token?.let { b.header("Authorization", "Bearer $it") }
        TestTls.wrap(http).newCall(b.build()).execute().use { r ->
            if (!r.isSuccessful) {
                if (r.code == 401) session.clear()
                throw ApiException(r.code, "HTTP ${r.code}", if (r.code == 404) apiMessage("firmware_not_found") else "Download del firmware non riuscito (HTTP ${r.code})")
            }
            val input = r.body?.byteStream() ?: throw java.io.IOException("Risposta vuota")
            dest.outputStream().use { out ->
                val buf = ByteArray(64 * 1024)
                var done = 0L
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    out.write(buf, 0, n)
                    done += n
                    onBytes(done)
                }
            }
        }
    }

    suspend fun firmwareReport(mac: String?, from: String, to: String, ok: Boolean, message: String?) {
        request(
            "POST",
            "/api/firmware/report",
            buildJsonObject {
                mac?.let { put("mac", it) }
                put("from", from.take(80))
                put("to", to.take(80))
                put("ok", ok)
                message?.let { put("message", it.take(300)) }
            },
        )
    }

    suspend fun pointing(lat: Double, lon: Double, height: Double?): PointingDto =
        AppJson.decodeFromString(PointingDto.serializer(), request("GET", "/api/pointing?lat=$lat&lon=$lon" + (height?.let { "&height=$it" } ?: "")))

    /** Guasti Enel map data, passed as is to the embedded map page. */
    suspend fun outagesMapJson(): String = request("GET", "/api/outages/map")

    suspend fun networkStatus(): NetworkStatusDto = AppJson.decodeFromString(NetworkStatusDto.serializer(), request("GET", "/api/network/status"))

    /** Personal Telegram of the account (every user); servers before v1.29 only had the Guasti Enel path. */
    private suspend fun telegram(method: String, sub: String, body: JsonElement? = null): String = try {
        request(method, "/api/account/telegram$sub", body)
    } catch (e: ApiException) {
        if (e.status == 404) request(method, "/api/outages/telegram$sub", body) else throw e
    }

    suspend fun outageTelegram(): OutageTelegramDto = AppJson.decodeFromString(OutageTelegramDto.serializer(), telegram("GET", ""))

    suspend fun outageTelegramLink(): TelegramLinkDto = AppJson.decodeFromString(TelegramLinkDto.serializer(), telegram("POST", "/link"))

    suspend fun outageTelegramVerify(): OutageTelegramDto = AppJson.decodeFromString(OutageTelegramDto.serializer(), telegram("POST", "/verify"))

    suspend fun outageTelegramSet(chatId: String?, planned: Boolean?): OutageTelegramDto =
        AppJson.decodeFromString(
            OutageTelegramDto.serializer(),
            telegram("PUT", "", buildJsonObject { chatId?.let { put("chatId", it) }; planned?.let { put("planned", it) } }),
        )

    suspend fun outageTelegramUnlink(): OutageTelegramDto = AppJson.decodeFromString(OutageTelegramDto.serializer(), telegram("DELETE", ""))

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
    suspend fun coverage(lat: Double, lon: Double): CoverageDto = AppJson.decodeFromString(CoverageDto.serializer(), coverageJson(lat, lon))

    /** The same answer as is, for the embedded map (positions, approximate areas, served sectors). */
    suspend fun coverageJson(lat: Double, lon: Double): String = request("GET", "/api/coverage?lat=$lat&lon=$lon&limit=5")

    /** Admins: more APs and a wider radius (the server ignores both for installers). */
    suspend fun coverageJson(lat: Double, lon: Double, limit: Int, km: Int?): String =
        request("GET", "/api/coverage?lat=$lat&lon=$lon&limit=$limit" + (km?.let { "&km=$it" } ?: ""))

    /** "Stato rete" as is: admins get every AP with its position (base map of Verifica copertura). */
    suspend fun networkStatusJson(): String = request("GET", "/api/network/status")

    /** Admins: radio simulation of one AP (estimated signal of a new CPE all around it). */
    suspend fun coverageSimulationJson(apId: String): String =
        request("GET", "/api/admin/coverage/simulation?apId=" + java.net.URLEncoder.encode(apId, "UTF-8"))

    /** Admins: default CPE height of Impostazioni server (metres above ground). */
    /** Home shortcuts of the account, the same on every phone (null: never customised). */
    suspend fun homeShortcuts(): List<String>? = shortcutIds(request("GET", "/api/auth/shortcuts"))

    suspend fun setHomeShortcuts(ids: List<String>?): List<String>? =
        shortcutIds(request("PUT", "/api/auth/shortcuts", buildJsonObject { put("ids", ids?.let { l -> kotlinx.serialization.json.JsonArray(l.map { kotlinx.serialization.json.JsonPrimitive(it) }) } ?: kotlinx.serialization.json.JsonNull) }))

    private fun shortcutIds(json: String): List<String>? =
        (AppJson.parseToJsonElement(json).jsonObject["ids"] as? kotlinx.serialization.json.JsonArray)?.map { it.jsonPrimitive.content }

    suspend fun defaultCpeHeight(): Double? =
        runCatching { AppJson.parseToJsonElement(request("GET", "/api/admin/pointing/config")).jsonObject["cpeHeightM"]?.jsonPrimitive?.doubleOrNull }.getOrNull()

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
