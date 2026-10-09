package it.cdanet.cpeconfigurator.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

@Serializable
data class UserDto(val id: Int, val username: String, val role: String)

@Serializable
data class LoginRequest(val username: String, val password: String)

@Serializable
data class LoginResponse(val token: String, val expiresAt: String, val user: UserDto, val deviceExpiresAt: String? = null)

/** /api/auth/login: a session, or (two-step verification) a 5-minute token for the code step. */
@Serializable
data class LoginStep(
    val token: String? = null,
    val expiresAt: String? = null,
    val user: UserDto? = null,
    val mfaRequired: Boolean = false,
    val mfaToken: String? = null,
)

@Serializable
data class TotpLoginRequest(val mfaToken: String, val code: String)

@Serializable
data class SeriesDto(val points: List<List<Double>> = emptyList(), val min: Double? = null, val avg: Double? = null, val max: Double? = null, val trend: Double? = null)

@Serializable
data class UispOutageDto(val start: String? = null, val end: String? = null, val type: String? = null, val inProgress: Boolean = false)

/** GET /api/provisioning/jobs/{id}/uisp/statistics */
@Serializable
data class SignalHistoryDto(
    val signal: SeriesDto = SeriesDto(),
    val remoteSignal: SeriesDto = SeriesDto(),
    val downlinkCapacity: SeriesDto = SeriesDto(),
    val uplinkCapacity: SeriesDto = SeriesDto(),
    val outages: List<UispOutageDto>? = null,
)

/** Body of POST /api/provisioning/jobs/{id}/replace: the rest comes from the replaced job. */
@Serializable
data class ReplaceRequest(
    val model: String,
    val mac: String,
    val serial: String,
    val pppoePassword: String? = null,
    val templateId: Int? = null,
    val location: CpeLocation? = null,
)

@Serializable
data class PasswordChangeRequest(val currentPassword: String, val newPassword: String)

@Serializable
data class PasswordChangeResponse(val token: String, val expiresAt: String)

@Serializable
data class HealthDto(
    val ok: Boolean = false,
    val version: String = "",
    val targetFirmware: String = "",
    val minAndroidVersion: String = "",
)

@Serializable
data class RangeDto(val min: Int, val max: Int)

@Serializable
data class SsidMetaDto(val pattern: String, val node: RangeDto, val district: RangeDto)

@Serializable
data class MetaDto(
    val version: String,
    val models: List<String>,
    val targetFirmware: String,
    val ssid: SsidMetaDto,
    val factoryIp: String,
    val jobTtlMinutes: Int,
    val uisp: Boolean = false,
    val coverageMaxKm: Int = 15,
    /** Optional features enabled by the admin ("Funzionalità"). */
    val modules: Map<String, Boolean> = emptyMap(),
)

@Serializable
data class OutageZoneDto(val name: String = "", val distanceM: Int = 0)

@Serializable
data class OutageImpactDto(val type: String = "", val name: String = "", val distanceM: Int = 0, val stations: Int? = null)

@Serializable
data class ReverseGeocodeDto(val label: String = "", val street: String = "", val houseNumber: String = "", val city: String = "", val province: String = "", val postcode: String = "")

@Serializable
data class OutageDto(
    val id: Long,
    val kind: String,
    val cause: String = "",
    val customers: Int = 0,
    val start: String? = null,
    val expectedRestore: String? = null,
    val place: String = "",
    val province: String = "",
    val lat: Double,
    val lon: Double,
    val zones: List<OutageZoneDto> = emptyList(),
    val impact: List<OutageImpactDto> = emptyList(),
)

@Serializable
data class OutageRunDto(val at: String? = null, val ok: Boolean = true, val error: String? = null)

@Serializable
data class OutageItemDto(val key: String = "", val name: String = "")

/** What the user may see: admins everything, installers only the POPs/APs/zones assigned by the admin. */
@Serializable
data class OutageScopeDto(val all: Boolean = true, val assigned: List<OutageItemDto> = emptyList())

@Serializable
data class OutageZoneItemDto(
    val id: String = "",
    val name: String = "",
    val lat: Double = 0.0,
    val lon: Double = 0.0,
    val radiusKm: Double = 0.0,
    /** Rules of a personal area: paused (no notifications) and which outages notify. */
    val paused: Boolean = false,
    val notifyMt: Boolean = true,
    val notifyBt: Boolean = true,
    val notifyPlanned: Boolean = false,
    /** Outages in the area right now. */
    val activeCount: Int = 0,
)

@Serializable
data class MyZonesDto(val zones: List<OutageZoneItemDto> = emptyList(), val max: Int = 20)

/** Personal Telegram notifications (bot configured by the admin). */
@Serializable
data class OutageTelegramDto(
    val available: Boolean = false,
    val linked: Boolean = false,
    val chatHint: String = "",
    val planned: Boolean = true,
    /** Why not available: "no_bot", "personal_off", "module_off". */
    val reason: String? = null,
    /** Admins can turn it on themselves (console → Connettori → Telegram). */
    val canConfigure: Boolean = false,
    /** The user receives the Guasti Enel notifications (module on for them). */
    val outages: Boolean = true,
)

@Serializable
data class ApproxDto(val lat: Double, val lon: Double, val radiusM: Int = 1500)

@Serializable
data class PointingFromDto(val lat: Double, val lon: Double, val ground: Double? = null, val height: Double = 6.0, val altitude: Double? = null)

@Serializable
data class SignalEstimateDto(
    val signalDbm: Int? = null,
    val low: Int? = null,
    val high: Int? = null,
    val inSector: Boolean? = null,
    val confidence: String = "bassa",
    val basis: Int? = null,
    val beyondServed: Boolean = false,
    val nearby: Int? = null,
) {
    /** "−63 dBm (−67…−59) · affidabilità alta · fuori dal settore servito", or null without customers. */
    fun describe(): String? = signalDbm?.let { s ->
        listOfNotNull(
            "Segnale stimato $s dBm ($low…$high)",
            "affidabilità $confidence",
            if (inSector == false) "fuori dal settore servito" else null,
            if (beyondServed) "più lontano dei clienti attuali" else null,
            basis?.let { b -> "da $b clienti" },
        ).joinToString(" · ")
    }
}

@Serializable
data class PointingApDto(
    val id: String,
    val name: String = "",
    val ssid: String? = null,
    val siteName: String? = null,
    val status: String = "",
    val bearing: Int = 0,
    val direction: String = "",
    val distanceM: Int = 0,
    val altitude: Double? = null,
    /** "gps" = the AP's own GPS (from UISP), "terreno" = terrain model + configured antenna height. */
    val altitudeFrom: String? = null,
    val tiltDeg: Double? = null,
    val lat: Double? = null,
    val lon: Double? = null,
    val approx: ApproxDto? = null,
    val estimate: SignalEstimateDto? = null,
)

/** "Trova l'AP": nearest APs from the installation point with altitude and tilt. */
@Serializable
data class PointingDto(
    val from: PointingFromDto,
    val apHeightM: Double = 15.0,
    val maxKm: Int = 15,
    val restricted: Boolean = false,
    val assignedCount: Int? = null,
    val aps: List<PointingApDto> = emptyList(),
)

@Serializable
data class NetCpeDto(val total: Int = 0, val offline: Int = 0)

@Serializable
data class NetApDto(
    val id: String = "",
    val name: String = "",
    val ssid: String? = null,
    val state: String = "ok",
    val lastSeen: String? = null,
    val cpe: NetCpeDto? = null,
    val cpeOffline: String? = null,
    val powerOutage: Boolean = false,
)

@Serializable
data class NetPopDto(val id: String = "", val name: String = "", val state: String = "ok", val powerOutage: Boolean = false, val aps: List<NetApDto> = emptyList())

@Serializable
data class NetSummaryDto(val aps: Int = 0, val down: Int = 0, val degraded: Int = 0, val powerOutage: Int = 0)

/** "Stato rete": state of the POPs/APs the user may see. */
@Serializable
data class NetworkStatusDto(
    val generatedAt: String? = null,
    val restricted: Boolean = false,
    val assignedCount: Int? = null,
    val summary: NetSummaryDto = NetSummaryDto(),
    val pops: List<NetPopDto> = emptyList(),
    val apsWithoutPop: List<NetApDto> = emptyList(),
)

@Serializable
data class TelegramLinkDto(val bot: String = "", val code: String = "", val url: String = "", val expiresInMin: Int = 15)

@Serializable
data class OutagesDto(val active: List<OutageDto> = emptyList(), val lastRun: OutageRunDto? = null, val generatedAt: String? = null, val scope: OutageScopeDto = OutageScopeDto())

@Serializable
data class CpeNowDto(
    val status: String = "",
    val signal: Double? = null,
    val ethMbps: Int? = null,
    val ethHalfDuplex: Boolean = false,
    val firmware: String = "",
    val apName: String? = null,
    val lastSeen: String? = null,
)

@Serializable
data class CpeHealthItemDto(
    /** null for CPEs assigned by the admin that were not installed with the app. */
    val jobId: String? = null,
    val createdAt: String? = null,
    /** "app" (installed with the app) or "uisp" (assigned by the admin). */
    val source: String = "app",
    val deviceName: String = "",
    val model: String = "",
    val mac: String,
    val ssid: String = "",
    val acceptanceSignal: Double? = null,
    val now: CpeNowDto? = null,
    val signalDelta: Int? = null,
    val issues: List<String> = emptyList(),
    /** Who installed it (admin view) and the installer it is assigned to, if any. */
    val installer: String = "",
    val assignedTo: AssignedUserDto? = null,
)

@Serializable
data class AssignedUserDto(val id: Int = 0, val username: String = "")

@Serializable
data class CpeHealthTotalsDto(
    val cpes: Int = 0,
    val ok: Int = 0,
    val offline: Int = 0,
    @kotlinx.serialization.SerialName("signal_drop") val signalDrop: Int = 0,
    val ethernet: Int = 0,
)

@Serializable
data class CpeHealthDto(val totals: CpeHealthTotalsDto = CpeHealthTotalsDto(), val cpes: List<CpeHealthItemDto> = emptyList())

@Serializable
data class ProvisionRequest(
    val model: String,
    val mac: String,
    val serial: String,
    val ssid: String,
    val pppoeUser: String,
    /** null when the job starts from a work order: the server uses the office's sealed password. */
    val pppoePassword: String? = null,
    /** Named template of the model; null = the model's default (omitted from JSON). */
    val templateId: Int? = null,
    val location: CpeLocation? = null,
    val workOrderId: Long? = null,
)

/** A work order of the office (agenda): never the PPPoE password, only whether it is set. */
@Serializable
data class WorkOrderDto(
    val id: Long,
    val day: String,
    val slot: String = "",
    val kind: String = "new",
    val kindLabel: String = "",
    val customer: String,
    val address: String = "",
    val lat: Double? = null,
    val lon: Double? = null,
    val contact: String = "",
    val pppoeUser: String = "",
    val hasPassword: Boolean = false,
    val model: String = "",
    val notes: String = "",
    val status: String = "open",
    val statusNote: String = "",
    val overdue: Boolean = false,
    val jobId: String? = null,
)

@Serializable
data class WorkOrdersDto(val day: String = "", val items: List<WorkOrderDto> = emptyList())

/** CPE position: phone GPS, geocoded address or manual entry. */
@Serializable
data class CpeLocation(val latitude: Double, val longitude: Double, val accuracy: Double? = null, val source: String)

@Serializable
data class GeocodeResult(val label: String, val lat: Double, val lon: Double)

@Serializable
data class CoverageAp(
    val id: String,
    val name: String = "",
    val ssid: String? = null,
    val siteName: String? = null,
    val status: String = "",
    val stations: Int? = null,
    val frequency: Int? = null,
    val distanceM: Int,
    val bearing: Int,
    val direction: String,
    val node: Int? = null,
    val district: Int? = null,
    /** Relay ("rilancio") number of the AP: SSID …-R{n}. */
    val relay: Int? = null,
    /** Expected signal of a new CPE here, from the customers already on this AP. */
    val estimate: SignalEstimateDto? = null,
)

@Serializable
data class CoverageDto(val maxKm: Int, val aps: List<CoverageAp>, val restricted: Boolean = false, val assignedCount: Int? = null)

@Serializable
/** isDefault = default for the signed-in installer (personal default if any, else the model default). */
data class TemplateDto(val id: Int, val model: String, val name: String, val isDefault: Boolean = false, val personal: Boolean = false)

@Serializable
data class ReadinessDto(val missing: List<String> = emptyList())

@Serializable
data class PlanDto(
    val targetFirmware: String,
    val factoryIp: String,
    val readiness: ReadinessDto,
    val steps: List<String>,
)

@Serializable
data class TargetDto(val host: String, val sshPort: Int = 22)

@Serializable
data class CredentialsDto(val username: String, val password: String)

@Serializable
data class ChecksDto(val firmware: String, val boardMatch: String, val mac: String)

@Serializable
data class ConfigDto(val path: String = "/tmp/system.cfg", val text: String, val sha256: String)

@Serializable
data class JobSummaryDto(
    val model: String,
    val template: String = "",
    val ssid: String,
    val pppoeUser: String,
    val deviceName: String,
    val mac: String,
    val serial: String,
)

@Serializable
data class AfterApplyDto(val lanIp: String, val httpPort: Int, val httpsPort: Int)

/** Provisioning package: contains secrets, kept in memory only. */
@Serializable
data class ProvisionPackage(
    val jobId: String,
    val expiresAt: String,
    val target: TargetDto,
    val credentials: CredentialsDto,
    val checks: ChecksDto,
    val config: ConfigDto,
    val summary: JobSummaryDto,
    val afterApply: AfterApplyDto,
) {
    override fun toString(): String = "ProvisionPackage(jobId=$jobId, model=${summary.model})"
}

@Serializable
data class DetectedDto(val firmware: String? = null, val board: String? = null, val mac: String? = null)

@Serializable
data class ProvisionResult(
    val result: String,
    val stages: List<String>,
    val error: String = "",
    val detected: DetectedDto = DetectedDto(),
    val completedAt: String? = null,
)

@Serializable
data class PendingResult(val jobId: String, val result: ProvisionResult, val label: String)

@Serializable
data class JobDto(
    val id: String,
    val createdAt: String,
    val completedAt: String? = null,
    val status: String,
    val model: String,
    val template: String? = null,
    val mac: String,
    val serial: String,
    val ssid: String,
    val pppoeUser: String,
    val deviceName: String = "",
    val stages: List<String> = emptyList(),
    val error: String = "",
    val installer: String = "",
    val acceptance: String? = null,
    val photos: Int = 0,
    val replacesJobId: String? = null,
    /** Write attempts of the package (a failed write can be retried). */
    val attempts: Int = 1,
    /** NOC approval of an acceptance test with poor radio: pending, approved, rejected. */
    val review: String? = null,
    /** Latest open "postponed"/"KO" report of the installation. */
    val ko: KoOpenDto? = null,
    val koCount: Int = 0,
)

@Serializable
data class KoOpenDto(val kind: String, val reason: String)

/** Measures attached to a KO report (what the app saw at that moment). */
@Serializable
data class KoMeasures(val signal: Int? = null, val expectedSignal: Int? = null, val distanceM: Int? = null, val apName: String? = null, val associated: Boolean? = null)

/** Installation postponed or definitive KO, reported from any step: never blocks a retry. */
@Serializable
data class KoRequest(
    val kind: String,
    val jobId: String? = null,
    val mode: String,
    val step: String,
    val reason: String,
    val note: String,
    val retryOn: String? = null,
    val mac: String? = null,
    val ssid: String? = null,
    val measures: KoMeasures = KoMeasures(),
)

@Serializable
data class KoCreatedDto(val id: Long)

@Serializable
data class NotificationDto(val id: Long, val createdAt: String, val kind: String, val title: String, val body: String = "", val jobId: String? = null, val mac: String = "", val readAt: String? = null)

@Serializable
data class NotificationsDto(val unread: Int = 0, val items: List<NotificationDto> = emptyList())

@Serializable
data class UnreadDto(val unread: Int = 0)

@Serializable
data class WirelessNetworkDto(val ssid: String, val updatedAt: String = "")

/** Key of this phone for the quick (biometric) login: memory only until encrypted in the keystore. */
@Serializable
data class DeviceKeyDto(val id: String, val secret: String, val expiresAt: String? = null) {
    override fun toString(): String = "DeviceKeyDto(id=$id)"
}

@Serializable
data class AuthDeviceDto(val id: String, val name: String = "", val createdAt: String = "", val lastUsedAt: String? = null, val active: Boolean = true)

@Serializable
data class AuthDevicesDto(val devices: List<AuthDeviceDto> = emptyList())

/** WPA2 key of the AP a CPE is moved to (guided installation): memory only, never logged. */
@Serializable
data class RelinkDto(val ssid: String, val psk: String, val sshPort: Int = 22) {
    override fun toString(): String = "RelinkDto(ssid=$ssid)"
}

/** Installation job of a CPE found on the roof (null = installed before the app or by someone else). */
@Serializable
data class CpeJobDto(val job: JobDto? = null)

@Serializable
data class RosCommandDto(val command: String, val title: String)

@Serializable
data class RosSectionDto(val id: String, val title: String, val commands: List<RosCommandDto>)

@Serializable
data class RosCatalogDto(val sections: List<RosSectionDto>)

@Serializable
data class ApiErrorDto(val error: String = "", val minVersion: String? = null, val missing: List<String>? = null, val extra: JsonElement? = null)

/** Line of sight towards an AP over the terrain (chart points in metres). */
@Serializable
data class LosPointDto(val d: Int, val ground: Double, val los: Double, val fresnel60: Double)

@Serializable
data class LosWorstDto(val d: Int = 0, val clearanceM: Double = 0.0, val fresnel60M: Double = 0.0)

@Serializable
data class LosDto(
    val distanceM: Int = 0,
    val cpeHeightM: Double = 0.0,
    val frequencyMhz: Int = 5600,
    val verdict: String = "clear",
    val worst: LosWorstDto? = null,
    val raiseCpeM: Double = 0.0,
    val chart: List<LosPointDto> = emptyList(),
)

/** An airOS image of the target version the server offers for the field upgrade. */
@Serializable
data class FirmwareImageDto(
    val id: Int,
    val platform: String,
    val version: String,
    val build: String = "",
    val size: Long = 0,
    val sha256: String,
    val md5: String,
)

@Serializable
data class FirmwareListDto(val target: String = "", val items: List<FirmwareImageDto> = emptyList())
