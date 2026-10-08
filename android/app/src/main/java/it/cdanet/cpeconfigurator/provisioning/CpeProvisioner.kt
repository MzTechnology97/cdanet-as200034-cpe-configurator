package it.cdanet.cpeconfigurator.provisioning

import it.cdanet.cpeconfigurator.data.DetectedDto
import it.cdanet.cpeconfigurator.data.ProvisionPackage
import it.cdanet.cpeconfigurator.network.Ip
import it.cdanet.cpeconfigurator.ssh.SshConnection
import java.io.IOException
import java.net.InetSocketAddress
import java.net.Socket
import java.time.Instant

class ProvisioningFailure(message: String, val detected: DetectedDto?, cause: Throwable? = null) : Exception(message, cause)

/**
 * Applies a server-rendered system.cfg to a factory CPE over SSH.
 * Must run with the process bound to the CPE Wi-Fi (see NetworkHelper.onWifi).
 */
class CpeProvisioner(private val onStage: (String) -> Unit) {

    fun probe(host: String, ports: List<Int> = listOf(22, 80, 443, 20080, 20443)): List<Int> {
        require(Ip.isPrivate(host)) { "Target CPE non locale" }
        return ports.filter { port ->
            runCatching { Socket().use { it.connect(InetSocketAddress(host, port), 800) } }.isSuccess
        }
    }

    fun provision(pkg: ProvisionPackage): DetectedDto {
        if (Instant.parse(pkg.expiresAt).isBefore(Instant.now())) {
            throw ProvisioningFailure("Pacchetto scaduto: torna online e preparalo di nuovo", null)
        }
        val host = pkg.target.host
        if (!Ip.isPrivate(host)) throw ProvisioningFailure("Target CPE non locale", null)
        val bytes = pkg.config.text.toByteArray(Charsets.UTF_8)
        if (DeviceCheck.sha256Hex(bytes) != pkg.config.sha256.lowercase()) {
            throw ProvisioningFailure("Integrità della configurazione non verificata (SHA-256)", null)
        }

        var detected: DetectedDto? = null
        try {
            onStage("Connessione SSH a $host")
            SshConnection.connect(host, pkg.target.sshPort, pkg.credentials.username, pkg.credentials.password).use { ssh ->
                onStage("Lettura firmware, board e MAC")
                val rb = DeviceCheck.parse(ssh.exec(DeviceCheck.READBACK_COMMAND, 8_000).stdout)
                detected = rb.detected()
                DeviceCheck.verify(rb, pkg.checks)
                onStage("Verificati firmware ${pkg.checks.firmware}, board e MAC ${pkg.summary.mac}")

                onStage("Trasferimento system.cfg (${bytes.size} byte)")
                val write = ssh.exec("umask 077; cat > /tmp/system.cfg", 15_000, stdin = bytes)
                if (write.exitCode != 0) throw IOException("Scrittura /tmp/system.cfg fallita: ${write.stderr.take(200)}")
                val check = ssh.exec("wc -c < /tmp/system.cfg; md5sum /tmp/system.cfg 2>/dev/null", 8_000).stdout
                val size = check.lineSequence().firstOrNull()?.trim()?.toIntOrNull()
                if (size != bytes.size) throw IOException("Dimensione /tmp/system.cfg inattesa ($size invece di ${bytes.size})")
                val md5 = Regex("""\b([0-9a-f]{32})\b""").find(check)?.groupValues?.get(1)
                if (md5 != null && md5 != DeviceCheck.md5Hex(bytes)) throw IOException("Checksum /tmp/system.cfg non corrispondente")
                onStage("Configurazione trasferita e verificata")

                val commit = ssh.exec(DeviceCheck.COMMIT_COMMAND, 30_000)
                if (commit.exitCode != 0) throw IOException("cfgmtd fallito (${commit.exitCode}): ${commit.stderr.take(200)}")
                onStage("Configurazione salvata in flash (cfgmtd)")

                ssh.execDetached("reboot")
                onStage("Riavvio CPE richiesto")
            }
            return detected ?: DetectedDto()
        } catch (e: ProvisioningFailure) {
            throw e
        } catch (e: Exception) {
            throw ProvisioningFailure(e.message ?: e.toString(), detected, e)
        }
    }
}
