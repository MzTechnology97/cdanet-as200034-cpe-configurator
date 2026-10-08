package it.cdanet.cpeconfigurator.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

@Serializable
data class UserDto(val id: Int, val username: String, val role: String)

@Serializable
data class LoginRequest(val username: String, val password: String)

@Serializable
data class LoginResponse(val token: String, val expiresAt: String, val user: UserDto)

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
)

@Serializable
data class ProvisionRequest(
    val model: String,
    val mac: String,
    val serial: String,
    val ssid: String,
    val pppoeUser: String,
    val pppoePassword: String,
    /** Named template of the model; null = the model's default (omitted from JSON). */
    val templateId: Int? = null,
)

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
)

@Serializable
data class WirelessNetworkDto(val ssid: String, val updatedAt: String = "")

@Serializable
data class RosCommandDto(val command: String, val title: String)

@Serializable
data class RosSectionDto(val id: String, val title: String, val commands: List<RosCommandDto>)

@Serializable
data class RosCatalogDto(val sections: List<RosSectionDto>)

@Serializable
data class ApiErrorDto(val error: String = "", val minVersion: String? = null, val missing: List<String>? = null, val extra: JsonElement? = null)
