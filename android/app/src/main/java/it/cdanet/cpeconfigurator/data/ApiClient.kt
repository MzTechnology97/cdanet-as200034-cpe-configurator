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
    "optimizer_disabled" to "Ottimizzazione automatica spenta: Impostazioni server → Assistente rete (console)",
    "finding_not_optimizable" to "Questo avviso non si risolve cambiando il canale dell'AP",
    "finding_without_channel" to "L'avviso non ha un canale consigliato: usa \"Cerca il canale migliore\"",
    "already_scheduled" to "C'è già un'ottimizzazione programmata o in corso per questo AP",
    "advisor_data_missing" to "Dati dell'analisi non ancora pronti: rileggi UISP e riprova tra due minuti",
    "no_candidates" to "Nessun canale candidato dentro la banda consentita",
    "not_cancellable" to "Questa ottimizzazione non si può più annullare",
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
    "cpe_not_in_stock" to "Questa CPE non risulta nel tuo magazzino: usa una CPE del tuo magazzino o chiedi all'ufficio",
    "template_needs_mac" to "Questo template ha bisogno del MAC già in preparazione: prepara la configurazione sul posto",
    "user_not_found" to "Installatore non trovato o disattivato",
    "invalid_position" to "Posizione non valida",
    "acceptance_already_passed" to "Il collaudo risulta già superato",
    "acceptance_not_found" to "Collaudo non ancora registrato: il rapporto c'è dopo l'invio del collaudo",
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
    "uisp_device_not_found" to "CPE non ancora vista dalla rete: i dati compaiono dopo che il NOC l'ha accettata",
)

/** Codes that name a data source (uisp_…, crm_…): never shown as they are. */
private val SOURCE_CODE = Regex("^(uisp|crm|ispbilling|edistribuzione)_")

fun apiMessage(code: String): String = ERRORS[code] ?: if (SOURCE_CODE.containsMatchIn(code)) "Servizio di rete non disponibile in questo momento, riprova più tardi" else code

/** Thin JSON client for the CDA Net server. */
class ApiClient(
    private val settings: Settings,
    private val session: Session,
    private val clientHeader: String,
    private val http: OkHttpClient = defaultHttp(),
    private val network: it.cdanet.cpeconfigurator.network.NetworkHelper? = null,
) {
    /** The client routed through [routedNet] (built once per network). */
    @Volatile private var routed: Triple<android.net.Network, OkHttpClient, OkHttpClient>? = null

    /**
     * The client for our server. On the CPE's Wi-Fi (no Internet) the default route ends at the
     * CPE, which answers with its own certificate ("Trust anchor ... not found"): the calls go
     * through the network that has Internet instead, mobile data, so the server stays reachable.
     */
    private fun serverClient(): OkHttpClient {
        val base = TestTls.wrap(http)
        val net = network?.internetNetwork() ?: return base
        routed?.let { (n, b, c) -> if (n == net && b === base) return c }
        val c = base.newBuilder().socketFactory(net.socketFactory).dns(object : okhttp3.Dns { override fun lookup(hostname: String) = net.getAllByName(hostname).toList() }).build()
        routed = Triple(net, base, c)
        return c
    }

    /** No network of the phone reaches Internet: a clear sentence instead of a TLS or socket error. */
    private fun offline(e: IOException): IOException =
        if (e !is ApiException && network?.noInternet() == true) {
            IOException("Senza Internet: il telefono è su una Wi-Fi senza Internet (es. quella della CPE) e senza dati mobili. Questi dati del server tornano quando sei online.", e)
        } else {
            e
        }

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
            try {
                serverClient().newCall(b.build()).execute()
            } catch (e: IOException) {
                throw offline(e)
            }.use { r ->
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

    /** The acceptance test registered for a job (null when none), with the NOC's override if any. */
    suspend fun storedAcceptance(jobId: String): StoredAcceptanceResponseDto =
        AppJson.decodeFromString(StoredAcceptanceResponseDto.serializer(), request("GET", "/api/provisioning/jobs/$jobId/acceptance"))

    /** NOC: a test «non superato» or «con riserva» becomes «superato», with the reason. */
    suspend fun passAcceptance(jobId: String, note: String) {
        request("POST", "/api/admin/provisioning/jobs/$jobId/acceptance/pass", buildJsonObject { put("note", note) })
    }

    /** The acceptance report of a job as a PDF (the same as the console's): the server checks who may. */
    suspend fun acceptancePdf(jobId: String): ByteArray = withContext(Dispatchers.IO) {
        val b = Request.Builder().url((base() + "/api/provisioning/jobs/$jobId/acceptance.pdf").toHttpUrl())
            .header("Accept", "application/pdf").header("Cache-Control", "no-store")
        session.token?.let { b.header("Authorization", "Bearer $it") }
        try {
            serverClient().newCall(b.build()).execute()
        } catch (e: IOException) {
            throw offline(e)
        }.use { r ->
            if (!r.isSuccessful) {
                val err = runCatching { AppJson.decodeFromString(ApiErrorDto.serializer(), r.body?.string().orEmpty()) }.getOrNull()
                val code = err?.error?.ifBlank { null } ?: "HTTP ${r.code}"
                if (r.code == 401) session.clear()
                throw ApiException(r.code, code, apiMessage(code))
            }
            r.body?.bytes() ?: ByteArray(0)
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
        // the 3D view of the map (admins): terrain, imagery and their list need the session of the
        // app; only these paths of our own server get it, the rest of the page stays without
        val path = runCatching { java.net.URI(url).path }.getOrNull().orEmpty()
        if (path.startsWith("/api/admin/map/")) session.token?.let { b.header("Authorization", "Bearer $it") }
        return serverClient().newCall(b.build()).execute()
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

    /**
     * Re-pointing a CPE installed by someone else: its installation (exact MAC, else the only sibling),
     * handed over for the new acceptance test (on site only: the phone's GPS goes with it).
     * null: a CPE installed before the app.
     */
    suspend fun claimCpe(macs: List<String>, at: CpeLocation?): JobDto? {
        val body = buildJsonObject {
            put("macs", kotlinx.serialization.json.JsonArray(macs.take(8).map { kotlinx.serialization.json.JsonPrimitive(it) }))
            at?.let { l -> put("position", buildJsonObject { put("lat", l.latitude); put("lon", l.longitude); l.accuracy?.let { put("accuracyM", it) } }) }
        }
        return AppJson.decodeFromString(CpeJobDto.serializer(), request("POST", "/api/field/cpe/claim", body)).job
    }

    /** The earlier acceptance tests of an installation (re-pointings), newest first. */
    suspend fun acceptanceHistory(jobId: String): List<AcceptanceHistoryDto> =
        AppJson.decodeFromString(AcceptanceHistoryResponse.serializer(), request("GET", "/api/provisioning/jobs/$jobId/acceptance/history")).items

    /** Installation postponed or KO (reason always written by the technician). */
    suspend fun reportKo(req: KoRequest): Long =
        AppJson.decodeFromString(KoCreatedDto.serializer(), request("POST", "/api/installs/ko", AppJson.encodeToJsonElement(KoRequest.serializer(), req))).id

    /** IA-AP (admins): findings on APs and CPEs. */
    suspend fun advisor(): AdvisorDto = AppJson.decodeFromString(AdvisorDto.serializer(), request("GET", "/api/admin/advisor"))

    /** Hides a finding for [days] (0 = shows it again). */
    suspend fun dismissAdvice(id: String, days: Int) {
        request("POST", "/api/admin/advisor/dismiss", buildJsonObject { put("id", id); put("days", days) })
    }

    /** IA-AP automatic optimisation: state and runs. */
    suspend fun optimizer(): OptimizerDto = AppJson.decodeFromString(OptimizerDto.serializer(), request("GET", "/api/admin/advisor/optimizer"))

    /** Starts the optimisation of the AP of a finding, confirmed by the admin ([when]: now / night). */
    suspend fun startOptimizer(findingId: String, mode: String, `when`: String) {
        request("POST", "/api/admin/advisor/optimizer", buildJsonObject { put("findingId", findingId); put("mode", mode); put("when", `when`); put("confirm", true) })
    }

    /** Cancels a scheduled run or stops the active one (the AP goes back to its channel). */
    suspend fun cancelOptimizer(id: String) {
        request("POST", "/api/admin/advisor/optimizer/" + java.net.URLEncoder.encode(id, "UTF-8") + "/cancel", buildJsonObject { })
    }

    /** New data from UISP now (one or two minutes). */
    suspend fun refreshAdvisor() {
        request("POST", "/api/admin/advisor/refresh", buildJsonObject { })
    }

    suspend fun notifications(): NotificationsDto = AppJson.decodeFromString(NotificationsDto.serializer(), request("GET", "/api/notifications?limit=100"))

    suspend fun unreadNotifications(): Int = AppJson.decodeFromString(UnreadDto.serializer(), request("GET", "/api/notifications/count")).unread

    suspend fun markNotificationsRead(ids: List<Long>? = null) {
        val body = if (ids == null) buildJsonObject { put("all", true) } else buildJsonObject { put("ids", kotlinx.serialization.json.JsonArray(ids.map { kotlinx.serialization.json.JsonPrimitive(it) })) }
        request("POST", "/api/notifications/read", body)
    }

    /** Deletes the user's own notifications: [ids], or all the read ones ([which] = "read"), or all ("all"). */
    suspend fun deleteNotifications(ids: List<Long>? = null, which: String = "all") {
        val body = if (ids != null) buildJsonObject { put("ids", kotlinx.serialization.json.JsonArray(ids.map { kotlinx.serialization.json.JsonPrimitive(it) })) } else buildJsonObject { put(which, true) }
        request("POST", "/api/notifications/delete", body)
    }

    suspend fun putAcceptance(jobId: String, report: it.cdanet.cpeconfigurator.field.AcceptanceReport) {
        request("PUT", "/api/provisioning/jobs/$jobId/acceptance", AppJson.encodeToJsonElement(it.cdanet.cpeconfigurator.field.AcceptanceReport.serializer(), report))
    }

    /** Installation photo (JPEG) attached to a job. */
    suspend fun uploadPhoto(jobId: String, jpeg: ByteArray, caption: String) = withContext(Dispatchers.IO) {
        // what the photo shows (the server checks the required ones); none for a free caption
        val type = it.cdanet.cpeconfigurator.field.PhotoType.ofCaption(caption)?.key
        val url = (base() + "/api/provisioning/jobs/$jobId/photos").toHttpUrl().newBuilder().addQueryParameter("caption", caption)
            .apply { type?.let { t -> addQueryParameter("type", t) } }.build()
        val b = Request.Builder().url(url).post(jpeg.toRequestBody("image/jpeg".toMediaType()))
        session.token?.let { b.header("Authorization", "Bearer $it") }
        serverClient().newCall(b.build()).execute().use { r ->
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

    /** A screenshot taken by an account that may not (the NOC is told). */
    suspend fun reportScreenshot(screen: String, at: String? = null, kind: String = "screenshot") {
        request("POST", "/api/security/screenshot-attempt", buildJsonObject {
            put("screen", screen.take(80))
            at?.let { put("at", it) }
            put("kind", kind)
        })
    }

    suspend fun workOrders(): WorkOrdersDto = AppJson.decodeFromString(WorkOrdersDto.serializer(), request("GET", "/api/work-orders"))

    /** The CPEs in the installer's own warehouse. */
    suspend fun myStock(): MyStockDto = AppJson.decodeFromString(MyStockDto.serializer(), request("GET", "/api/warehouse/mine"))

    /** Calendario: the orders from [from] to [to] (YYYY-MM-DD, up to 62 days); [user] = one installer (NOC). */
    suspend fun workOrderCalendar(from: String, to: String, user: Long? = null): CalendarDto =
        AppJson.decodeFromString(CalendarDto.serializer(), request("GET", "/api/work-orders/calendar?from=$from&to=$to" + (user?.let { "&user=$it" } ?: "")))

    /** NOC: customers of the CRM matching [q] (name, code, phone, address or PPPoE user). */
    suspend fun workOrderCrm(q: String): WorkOrderCrmDto =
        AppJson.decodeFromString(WorkOrderCrmDto.serializer(), request("GET", "/api/admin/work-orders/crm?q=" + java.net.URLEncoder.encode(q.trim().take(80), "UTF-8")))

    /** NOC: a new work order from the app's calendar ([body] from OrderDraftMath.body). */
    suspend fun createWorkOrder(body: JsonObject): WorkOrderDto =
        AppJson.decodeFromString(WorkOrderItemDto.serializer(), request("POST", "/api/admin/work-orders", body)).item

    /** NOC: changes (day, time, installer, details) of a work order: only the fields in [body]. */
    suspend fun updateWorkOrder(id: Long, body: JsonObject): WorkOrderDto =
        AppJson.decodeFromString(WorkOrderItemDto.serializer(), request("PUT", "/api/admin/work-orders/$id", body)).item

    /** NOC: cancels a work order (one that led to an installation stays in the history). */
    suspend fun deleteWorkOrder(id: Long) {
        request("DELETE", "/api/admin/work-orders/$id")
    }

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

    suspend fun horizon(lat: Double, lon: Double, height: Double?): HorizonDto =
        AppJson.decodeFromString(HorizonDto.serializer(), request("GET", "/api/pointing/horizon?lat=$lat&lon=$lon" + (height?.let { "&height=$it" } ?: "")))

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
        serverClient().newCall(b.build()).execute().use { r ->
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

    /** [stale]: also the CPEs offline for longer than the server setting (normally left out). */
    suspend fun cpeHealth(stale: Boolean = false): CpeHealthDto = AppJson.decodeFromString(CpeHealthDto.serializer(), request("GET", "/api/cpe-health" + if (stale) "?stale=1" else ""))

    // ---- admin "Stato CPE" (UISP API through the server) ----
    suspend fun adminCpe(deviceId: String): AdminCpeDto =
        AppJson.decodeFromString(AdminCpeDto.serializer(), request("GET", "/api/admin/cpe/${java.net.URLEncoder.encode(deviceId, "UTF-8")}"))

    suspend fun adminCpeStats(deviceId: String, range: String): SignalHistoryDto =
        AppJson.decodeFromString(SignalHistoryDto.serializer(), request("GET", "/api/admin/cpe/${java.net.URLEncoder.encode(deviceId, "UTF-8")}/statistics?range=$range"))

    /** refresh, restart, upgrade, backups, backups/{id}/apply */
    suspend fun adminCpeAction(deviceId: String, action: String) {
        request("POST", "/api/admin/cpe/${java.net.URLEncoder.encode(deviceId, "UTF-8")}/$action")
    }

    /** Only the changed wireless parameters: the server rewrites the rest of the configuration as it is. */
    suspend fun adminCpeWireless(deviceId: String, body: JsonObject) {
        request("PUT", "/api/admin/cpe/${java.net.URLEncoder.encode(deviceId, "UTF-8")}/wireless", body)
    }

    suspend fun adminCpeMeta(deviceId: String, alias: String?, note: String?, maintenance: Boolean) {
        request(
            "PUT",
            "/api/admin/cpe/${java.net.URLEncoder.encode(deviceId, "UTF-8")}/meta",
            buildJsonObject {
                put("alias", alias?.ifBlank { null })
                put("note", note?.ifBlank { null })
                put("maintenance", maintenance)
            },
        )
    }

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
    /** [heightM]: CPE above the ground, for the terrain towards each AP (null: the server default). */
    suspend fun coverageJson(lat: Double, lon: Double, heightM: Double? = null, cpe: String = "auto"): String =
        request("GET", "/api/coverage?lat=$lat&lon=$lon&limit=5" + (heightM?.let { "&height=$it" } ?: "") + "&cpe=" + java.net.URLEncoder.encode(cpe, "UTF-8"))

    /** Admins: more APs and a wider radius (the server ignores both for installers). */
    suspend fun coverageJson(lat: Double, lon: Double, limit: Int, km: Int?, heightM: Double? = null, cpe: String = "auto"): String =
        request("GET", "/api/coverage?lat=$lat&lon=$lon&limit=$limit" + (km?.let { "&km=$it" } ?: "") + (heightM?.let { "&height=$it" } ?: "") + "&cpe=" + java.net.URLEncoder.encode(cpe, "UTF-8"))

    /** "Stato rete" as is: admins get every AP with its position (base map of Verifica copertura). */
    suspend fun networkStatusJson(): String = request("GET", "/api/network/status")

    /** Admins: radio simulation of one AP (estimated signal of a new CPE all around it). */
    suspend fun coverageSimulationJson(apId: String, cpe: String? = null): String =
        request("GET", "/api/admin/coverage/simulation?apId=" + java.net.URLEncoder.encode(apId, "UTF-8") + (cpe?.let { "&cpe=" + java.net.URLEncoder.encode(it, "UTF-8") } ?: ""))

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
