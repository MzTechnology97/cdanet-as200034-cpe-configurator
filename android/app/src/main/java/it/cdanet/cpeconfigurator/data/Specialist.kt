package it.cdanet.cpeconfigurator.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/*
 * The Specialist's section (owner, 17/10/2026): he works on his own for other companies, with CPEs
 * that are not CDA Net's. His airOS templates, the connectors of those companies (their UISP) and
 * his installations live on the server apart from CDA Net's; the Wi-Fi key, the PPPoE and CPE
 * passwords are typed in the app for each CPE and only go into the file written into it.
 */

@Serializable
data class SpecFactsDto(
    val lanIp: String? = null,
    val wirelessMode: String = "station",
    val netMode: String = "router",
    val ptp: Boolean = false,
    val sshPort: Int? = null,
    val httpPort: Int? = null,
    val httpsPort: Int? = null,
) {
    /** "Station PtMP · Router", as the console says it. */
    val mode: String get() = (if (wirelessMode == "ap") "Access Point" else "Station") + (if (ptp) " PtP" else " PtMP") + " · " + (if (netMode == "bridge") "Bridge" else "Router")
}

/** Which secrets the template keeps (sealed on the server, never returned): its author's. */
@Serializable
data class SpecSecretsSetDto(val snmpCommunity: Boolean = false, val wpa2Psk: Boolean = false)

@Serializable
data class SpecTemplateDto(
    val id: Int,
    val model: String,
    val name: String,
    val boardMatch: String = "",
    val notes: String = "",
    val sha256: String = "",
    val facts: SpecFactsDto = SpecFactsDto(),
    val placeholders: List<String> = emptyList(),
    /** His own placeholders (not CDA Net's): typed for each CPE. */
    val own: List<String> = emptyList(),
    val secretsSet: SpecSecretsSetDto = SpecSecretsSetDto(),
    val jobs: Int = 0,
    /** Who made it: he, or another specialist of his work groups (issue #275). */
    val authorId: Int? = null,
    val author: String = "",
    /** His own: he deletes it and sets its secrets; with another's he types them in the flow. */
    val mine: Boolean = true,
    val createdAt: String = "",
    val updatedAt: String = "",
    /** The text, only when one template is read. */
    val template: String? = null,
) {
    override fun toString(): String = "SpecTemplateDto(id=$id, model=$model, name=$name)"
}

@Serializable
data class SpecLastTestDto(val at: String = "", val ok: Boolean = false, val detail: String = "")

/** A company's connector (its UISP): token and device key stay sealed on the server. */
@Serializable
data class SpecConnectorDto(
    val id: Int,
    val kind: String = "uisp",
    val name: String,
    val url: String = "",
    val enabled: Boolean = true,
    val ignoreTls: Boolean = false,
    val tokenSet: Boolean = false,
    val tokenHint: String = "",
    val uispKeySet: Boolean = false,
    val lastTest: SpecLastTestDto? = null,
    val jobs: Int = 0,
)

@Serializable
data class SpecConnectorsDto(val items: List<SpecConnectorDto> = emptyList())

/** A value typed for each CPE: a placeholder of the template the server does not fill by itself. */
@Serializable
data class SpecAskedDto(val name: String, val label: String = "", val secret: Boolean = false, val own: Boolean = false)

@Serializable
data class SpecValuesDto(val placeholders: List<String> = emptyList(), val asked: List<SpecAskedDto> = emptyList())

/** The CPE's admin credentials after the configuration (also those of the template's placeholders). */
@Serializable
data class SpecCpeLoginDto(val username: String, val password: String) {
    override fun toString(): String = "SpecCpeLoginDto(username=$username)"
}

@Serializable
data class SpecLocationDto(val latitude: Double, val longitude: Double, val accuracy: Double? = null, val source: String)

/** POST /api/specialist/jobs: the keys are exactly the server's (it refuses any other). */
@Serializable
data class SpecJobRequest(
    val templateId: Int,
    val connectorId: Int? = null,
    val company: String? = null,
    val model: String,
    /** Null (with serial, firmware, host): prepared before connecting to the CPE, read at the write. */
    val mac: String? = null,
    val serial: String? = null,
    val firmware: String? = null,
    val host: String? = null,
    val sshPort: Int? = null,
    val cpe: SpecCpeLoginDto,
    val values: Map<String, String> = emptyMap(),
    val customer: String? = null,
    val notes: String? = null,
    val location: SpecLocationDto? = null,
) {
    override fun toString(): String = "SpecJobRequest(templateId=$templateId, model=$model, mac=$mac)"
}

/** The outcome of the write (the server's keys only). */
@Serializable
data class SpecResultDto(
    val result: String,
    val stages: List<String> = emptyList(),
    val error: String = "",
    val detected: DetectedDto = DetectedDto(),
    val completedAt: String? = null,
    /** The CPE written (MAC and serial read over SSH), for a configuration prepared before connecting to it. */
    val cpe: CpeIdDto? = null,
)

@Serializable
data class SpecPendingResult(val jobId: String, val result: SpecResultDto, val label: String)

@Serializable
data class SpecPositionDto(val lat: Double, val lon: Double, val source: String = "")

@Serializable
data class SpecRadioDto(
    val signal: Int? = null,
    val noise: Int? = null,
    val ccq: Double? = null,
    val txRate: Double? = null,
    val rxRate: Double? = null,
    val capacityDown: Double? = null,
    val capacityUp: Double? = null,
    val distanceM: Int? = null,
    val frequency: Int? = null,
    val channelWidth: Int? = null,
    val ssid: String? = null,
    val apName: String? = null,
    val apMac: String? = null,
)

@Serializable
data class SpecSpeedDto(val downMbps: Double, val upMbps: Double, val pingMs: Double? = null, val jitterMs: Double? = null, val server: String? = null)

/** The optional acceptance test: the specialist's own judgment, no NOC. */
@Serializable
data class SpecAcceptanceDto(
    val verdict: String? = null,
    val radio: SpecRadioDto? = null,
    val speedtest: SpecSpeedDto? = null,
    val heightM: Double? = null,
    val notes: String? = null,
    val at: String? = null,
)

@Serializable
data class SpecConnectorRefDto(val id: Int, val name: String = "")

@Serializable
data class SpecUispDto(val deviceId: String? = null, val siteId: String? = null, val site: String = "", val authorizedAt: String? = null, val error: String = "")

@Serializable
data class SpecJobDto(
    val id: String,
    /** Who installed it: he, or another specialist of his work groups (read only for him, issue #275). */
    val authorId: Int? = null,
    val author: String = "",
    val createdAt: String = "",
    val completedAt: String? = null,
    val status: String = "prepared",
    val attempts: Int = 0,
    val model: String = "",
    val template: String = "",
    val templateId: Int? = null,
    val mac: String = "",
    val serial: String = "",
    /** Prepared before connecting to the CPE: MAC and serial are the ones read at the write (empty until then). */
    val cpeAtWrite: Boolean = false,
    val firmware: String = "",
    val deviceName: String = "",
    val ssid: String = "",
    val pppoeUser: String = "",
    val customer: String = "",
    val notes: String = "",
    val company: String = "",
    val connector: SpecConnectorRefDto? = null,
    val location: SpecPositionDto? = null,
    val stages: List<String> = emptyList(),
    val detected: Map<String, String> = emptyMap(),
    val error: String = "",
    val acceptance: SpecAcceptanceDto? = null,
    val uisp: SpecUispDto = SpecUispDto(),
) {
    /** Written, with a company's UISP, and not yet authorized there. */
    val toAuthorize: Boolean get() = status == "success" && connector != null && uisp.authorizedAt == null
    val title: String get() = customer.ifBlank { deviceName }.ifBlank { mac }.ifBlank { model }

    /** The CPE in a line: its MAC, or why there is none yet. */
    val macLabel: String get() = mac.ifBlank { if (cpeAtWrite) "MAC letto alla scrittura" else "" }
}

@Serializable
data class SpecJobsDto(val total: Int = 0, val items: List<SpecJobDto> = emptyList())

@Serializable
data class SpecSummaryDto(
    val templates: Int = 0,
    val connectors: Int = 0,
    val jobs30d: Int = 0,
    val success30d: Int = 0,
    val toAuthorize: Int = 0,
    val failed30d: Int = 0,
)

@Serializable
data class SpecUispDeviceDto(
    val id: String,
    val name: String? = null,
    val mac: String? = null,
    val model: String? = null,
    val authorized: Boolean = false,
    val site: String? = null,
    val status: String? = null,
    val signal: Int? = null,
)

@Serializable
data class SpecSiteDto(val id: String, val name: String = "")

/** The CPE in the company's UISP: found by MAC, authorized or not, the site of its AP. */
@Serializable
data class SpecUispStateDto(
    val connector: String = "",
    val device: SpecUispDeviceDto? = null,
    val proposedSite: SpecSiteDto? = null,
    val authorizedAt: String? = null,
    val site: String? = null,
)

@Serializable
data class SpecAuthorizeDto(val ok: Boolean = false, val deviceId: String? = null, val site: String = "", val job: SpecJobDto? = null)

// ---- the template form (like the CPE's web interface) -----------------------------------------

@Serializable
data class SpecOptionDto(val value: String, val label: String = "")

@Serializable
data class SpecOnlyDto(val wirelessMode: String? = null, val netMode: String? = null)

@Serializable
data class SpecFieldDto(
    val id: String,
    val section: String,
    val label: String,
    val hint: String = "",
    /** bool, int, ip, host, text, select */
    val type: String,
    val options: List<SpecOptionDto> = emptyList(),
    val min: Double? = null,
    val max: Double? = null,
    val only: SpecOnlyDto? = null,
    val experimental: Boolean = false,
)

/** How the specialist fills each placeholder CDA Net knows. */
@Serializable
data class SpecPlaceholderDto(val name: String, val label: String = "", val secret: Boolean = false, val from: String = "typed")

@Serializable
data class SpecTemplateFormDto(
    val fields: List<SpecFieldDto> = emptyList(),
    val placeholders: List<SpecPlaceholderDto> = emptyList(),
    val models: List<String> = emptyList(),
    val boardMatch: Map<String, String> = emptyMap(),
    val targetFirmware: String = "",
)

@Serializable
data class SpecReportDto(
    val ok: Boolean = true,
    val errors: List<String> = emptyList(),
    val warnings: List<String> = emptyList(),
    val placeholders: List<String> = emptyList(),
    val own: List<String> = emptyList(),
    val lines: Int = 0,
)

@Serializable
data class SpecReplacementDto(val line: Int = 0, val key: String = "", val placeholder: String = "")

/** The form of a template text: its values, the fields not in the text, what it is, whether it is valid. */
@Serializable
data class SpecFormStateDto(
    val template: String = "",
    val values: Map<String, JsonElement> = emptyMap(),
    val missing: List<String> = emptyList(),
    val facts: SpecFactsDto = SpecFactsDto(),
    val report: SpecReportDto = SpecReportDto(),
    /** Made from a CPE's configuration: what became a placeholder, and why to check it. */
    val replacements: List<SpecReplacementDto> = emptyList(),
    val warnings: List<String> = emptyList(),
    val suggestedBoardMatch: String? = null,
)

@Serializable
data class CdaTemplateRefDto(val id: Int, val name: String = "")

@Serializable
data class CdaModelTemplatesDto(val model: String, val templates: List<CdaTemplateRefDto> = emptyList())

// ---- the calls --------------------------------------------------------------------------------

private fun enc(v: String): String = java.net.URLEncoder.encode(v, "UTF-8").replace("+", "%20")

suspend fun ApiClient.specSummary(): SpecSummaryDto = AppJson.decodeFromString(SpecSummaryDto.serializer(), request("GET", "/api/specialist/summary"))

suspend fun ApiClient.specTemplates(): List<SpecTemplateDto> =
    AppJson.decodeFromString(ListSerializer(SpecTemplateDto.serializer()), request("GET", "/api/specialist/templates"))

suspend fun ApiClient.specTemplate(id: Int): SpecTemplateDto = AppJson.decodeFromString(SpecTemplateDto.serializer(), request("GET", "/api/specialist/templates/$id"))

suspend fun ApiClient.specConnectors(): List<SpecConnectorDto> = AppJson.decodeFromString(SpecConnectorsDto.serializer(), request("GET", "/api/specialist/connectors")).items

/** What is typed for a template (with [connectorId], whether the company's UISP key fills its placeholder). */
suspend fun ApiClient.specValues(templateId: Int, connectorId: Int?): SpecValuesDto =
    AppJson.decodeFromString(SpecValuesDto.serializer(), request("GET", "/api/specialist/templates/$templateId/values" + (connectorId?.let { "?connectorId=$it" } ?: "")))

/** The configuration of a CPE, with what was typed: only this app may ask for it (it carries secrets). */
suspend fun ApiClient.specCreateJob(req: SpecJobRequest): ProvisionPackage =
    AppJson.decodeFromString(ProvisionPackage.serializer(), request("POST", "/api/specialist/jobs", AppJson.encodeToJsonElement(SpecJobRequest.serializer(), req), client = true))

suspend fun ApiClient.specSendResult(jobId: String, r: SpecResultDto) {
    request("POST", "/api/specialist/jobs/$jobId/result", AppJson.encodeToJsonElement(SpecResultDto.serializer(), r))
}

suspend fun ApiClient.specJobs(q: String = "", status: String? = null, limit: Int = 100): SpecJobsDto {
    val params = listOfNotNull(
        q.trim().takeIf { it.isNotEmpty() }?.let { "q=" + enc(it.take(100)) },
        status?.let { "status=$it" },
        "limit=$limit",
    ).joinToString("&")
    return AppJson.decodeFromString(SpecJobsDto.serializer(), request("GET", "/api/specialist/jobs?$params"))
}

suspend fun ApiClient.specJob(id: String): SpecJobDto = AppJson.decodeFromString(SpecJobDto.serializer(), request("GET", "/api/specialist/jobs/$id"))

suspend fun ApiClient.specDeleteJob(id: String) {
    request("DELETE", "/api/specialist/jobs/$id")
}

suspend fun ApiClient.specPutAcceptance(id: String, a: SpecAcceptanceDto): SpecJobDto =
    AppJson.decodeFromString(SpecJobDto.serializer(), request("PUT", "/api/specialist/jobs/$id/acceptance", AppJson.encodeToJsonElement(SpecAcceptanceDto.serializer(), a)))

suspend fun ApiClient.specUispState(id: String): SpecUispStateDto = AppJson.decodeFromString(SpecUispStateDto.serializer(), request("GET", "/api/specialist/jobs/$id/uisp"))

suspend fun ApiClient.specSites(connectorId: Int): List<SpecSiteDto> =
    AppJson.decodeFromString(ListSerializer(SpecSiteDto.serializer()), request("GET", "/api/specialist/connectors/$connectorId/sites"))

suspend fun ApiClient.specAuthorize(id: String, siteId: String?): SpecAuthorizeDto =
    AppJson.decodeFromString(SpecAuthorizeDto.serializer(), request("POST", "/api/specialist/jobs/$id/uisp/authorize", buildJsonObject { siteId?.let { put("siteId", it) } }))

suspend fun ApiClient.specTemplateForm(): SpecTemplateFormDto = AppJson.decodeFromString(SpecTemplateFormDto.serializer(), request("GET", "/api/specialist/template-form"))

/** The form of [template] (null: a new template from the form alone): nothing is stored. */
suspend fun ApiClient.specFormRead(model: String, template: String?): SpecFormStateDto =
    AppJson.decodeFromString(
        SpecFormStateDto.serializer(),
        request("POST", "/api/specialist/form/${enc(model)}/read", buildJsonObject { template?.let { put("template", it) } }),
    )

/** The form's [changes] written into [template] (only what changed): nothing is stored. */
suspend fun ApiClient.specFormApply(model: String, template: String, changes: Map<String, JsonPrimitive>): SpecFormStateDto =
    AppJson.decodeFromString(
        SpecFormStateDto.serializer(),
        request("POST", "/api/specialist/form/${enc(model)}/apply", buildJsonObject {
            put("template", template)
            put("changes", JsonObject(changes))
        }),
    )

/** The running configuration of a CPE made a template (its secrets become placeholders): nothing stored. */
suspend fun ApiClient.specAutoTemplate(model: String, backup: String): SpecFormStateDto =
    AppJson.decodeFromString(SpecFormStateDto.serializer(), request("POST", "/api/specialist/form/${enc(model)}/autotemplate", buildJsonObject { put("backup", backup) }))

/** A new template of his ([snmpCommunity]: sealed apart, never returned). */
suspend fun ApiClient.specCreateTemplate(model: String, name: String, template: String, boardMatch: String, notes: String, snmpCommunity: String?, wpa2Psk: String? = null): SpecTemplateDto =
    AppJson.decodeFromString(
        SpecTemplateDto.serializer(),
        request("POST", "/api/specialist/templates", buildJsonObject {
            put("model", model)
            put("name", name)
            put("template", template)
            if (boardMatch.isNotBlank()) put("boardMatch", boardMatch)
            put("notes", notes)
            snmpCommunity?.takeIf { it.isNotEmpty() }?.let { put("snmpCommunity", it) }
            wpa2Psk?.takeIf { it.isNotEmpty() }?.let { put("wpa2Psk", it) }
        }),
    )

/**
 * Changes to a template: [snmpCommunity] a value replaces it, [removeCommunity] removes it, else it
 * stays; the same for the Wi-Fi key of the AP ([wpa2Psk], [removeKey]).
 */
suspend fun ApiClient.specUpdateTemplate(
    id: Int,
    name: String,
    template: String,
    boardMatch: String,
    notes: String,
    snmpCommunity: String?,
    removeCommunity: Boolean,
    wpa2Psk: String? = null,
    removeKey: Boolean = false,
): SpecTemplateDto =
    AppJson.decodeFromString(
        SpecTemplateDto.serializer(),
        request("PATCH", "/api/specialist/templates/$id", buildJsonObject {
            put("name", name)
            put("template", template)
            if (boardMatch.isNotBlank()) put("boardMatch", boardMatch)
            put("notes", notes)
            when {
                !snmpCommunity.isNullOrEmpty() -> put("snmpCommunity", snmpCommunity)
                removeCommunity -> put("snmpCommunity", kotlinx.serialization.json.JsonNull)
            }
            when {
                !wpa2Psk.isNullOrEmpty() -> put("wpa2Psk", wpa2Psk)
                removeKey -> put("wpa2Psk", kotlinx.serialization.json.JsonNull)
            }
        }),
    )

suspend fun ApiClient.specDeleteTemplate(id: Int) {
    request("DELETE", "/api/specialist/templates/$id")
}

/** A copy of a CDA Net template as his own (the original stays as it is, its secrets do not come). */
suspend fun ApiClient.specCopyTemplate(fromId: Int, name: String): SpecTemplateDto =
    AppJson.decodeFromString(SpecTemplateDto.serializer(), request("POST", "/api/specialist/templates/copy", buildJsonObject { put("fromId", fromId); put("name", name) }))

/** CDA Net's templates (names only), the start of a copy. */
suspend fun ApiClient.cdaTemplates(): List<CdaModelTemplatesDto> =
    AppJson.decodeFromString(ListSerializer(CdaModelTemplatesDto.serializer()), request("GET", "/api/admin/profiles"))
