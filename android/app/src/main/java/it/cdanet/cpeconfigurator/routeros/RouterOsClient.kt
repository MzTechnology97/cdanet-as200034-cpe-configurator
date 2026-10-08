package it.cdanet.cpeconfigurator.routeros

import it.cdanet.cpeconfigurator.data.ApiClient
import it.cdanet.cpeconfigurator.data.RosCommandDto
import it.cdanet.cpeconfigurator.data.RosSectionDto
import it.cdanet.cpeconfigurator.network.Ip
import it.cdanet.cpeconfigurator.network.NetworkHelper
import it.cdanet.cpeconfigurator.ssh.SshConnection
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

data class RosOutput(val title: String, val command: String, val output: String)
data class RosResult(val host: String, val summary: Map<String, String>, val sections: List<RosOutput>)

/** Read-only RouterOS over SSH from the phone (LAN of the customer/site). */
class RouterOsClient(private val api: ApiClient, private val network: NetworkHelper) {
    @Volatile
    private var catalog: List<RosSectionDto> = RouterOsPolicy.FALLBACK_SECTIONS

    val sections: List<RosSectionDto> get() = catalog

    /** Refreshes the command catalogue from the server when online; keeps the bundled one otherwise. */
    suspend fun refreshCatalog() {
        runCatching { api.routerOsCatalog() }.getOrNull()?.sections?.takeIf { it.isNotEmpty() }?.let { catalog = it }
    }

    suspend fun run(host: String, port: Int, username: String, password: String, action: String, command: String = "", viaWifi: Boolean): RosResult =
        withContext(Dispatchers.IO) {
            val ip = Ip.resolvePrivate(host)
            val terminal = if (action == "terminal") RouterOsPolicy.readonlyCommand(command) else ""
            val section = catalog.firstOrNull { it.id == action }
            if (section == null && action != "dashboard" && action != "terminal") throw IllegalArgumentException("Modulo RouterOS non supportato")
            val block: suspend () -> RosResult = {
                SshConnection.connect(ip, port, username, password).use { ssh ->
                    fun output(cmd: String): String = runCatching {
                        val r = ssh.exec(cmd, 12_000)
                        RouterOsPolicy.redact((r.stdout.ifBlank { r.stderr }).trim())
                    }.getOrElse { "[non disponibile] ${RouterOsPolicy.redact(it.message.orEmpty())}" }

                    val summary = RouterOsPolicy.summarize(output("/system identity print"), output("/system resource print"), output("/system routerboard print"))
                    val outputs = when {
                        action == "terminal" -> listOf(RosOutput("Terminale RouterOS", terminal, output(terminal)))
                        section != null -> section.commands.map { c: RosCommandDto -> RosOutput(c.title, c.command, output(c.command)) }
                        else -> emptyList()
                    }
                    RosResult(ip, summary, outputs)
                }
            }
            if (viaWifi) network.onWifi(block) else block()
        }
}
