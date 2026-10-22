package it.cdanet.cpeconfigurator.provisioning

import it.cdanet.cpeconfigurator.data.CredentialsDto
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
 * Must run with the process bound to the CPE Wi-Fi (see NetworkHelper.onLocal).
 */
class CpeProvisioner(private val onStage: (String) -> Unit) {

    companion object {
        /** airOS factory credentials: a CPE just reset keeps them until the configuration sets the CDA Net ones. */
        val FACTORY = CredentialsDto("ubnt", "ubnt")

        /** Every credential refused, in CDA Net's installation. */
        const val REFUSED_CDA = "Autenticazione SSH rifiutata con le credenziali CDA Net e con quelle di fabbrica: fai il primo avvio airOS dalla card qui sotto, poi riprova"

        /**
         * SSH to the package's CPE with its credentials and, when they are refused, with the factory
         * ones: a new or reset CPE needs no manual first access, the written configuration sets the
         * CDA Net credentials. The message of a refusal starts with "Autenticazione".
         *
         * [extra]: the credentials the CPE may still have, tried before the factory ones (the
         * Specialist's flow: a CPE configured by another company); [refused] is the message when
         * every one is refused.
         */
        fun connect(pkg: ProvisionPackage, onStage: (String) -> Unit = {}, extra: List<CredentialsDto> = emptyList(), refused: String = REFUSED_CDA): SshConnection {
            val host = pkg.target.host
            try {
                return SshConnection.connect(host, pkg.target.sshPort, pkg.credentials.username, pkg.credentials.password)
            } catch (e: IOException) {
                if (!e.message.orEmpty().startsWith("Autenticazione")) throw e
                val others = (extra + FACTORY).distinct().filter { it != pkg.credentials }
                if (others.isEmpty()) throw e
                var last: IOException = e
                for (cr in others) {
                    try {
                        val ssh = SshConnection.connect(host, pkg.target.sshPort, cr.username, cr.password)
                        onStage(if (cr == FACTORY) "CPE nuova o resettata: accesso con le credenziali di fabbrica" else "Accesso con le credenziali attuali della CPE")
                        return ssh
                    } catch (f: IOException) {
                        if (!f.message.orEmpty().startsWith("Autenticazione")) throw f
                        last = f
                    }
                }
                throw IOException(refused, last)
            }
        }
    }

    fun probe(host: String, ports: List<Int> = listOf(22, 80, 443, 20080, 20443)): List<Int> {
        require(Ip.isPrivate(host)) { "Target CPE non locale" }
        return ports.filter { port ->
            runCatching { Socket().use { it.connect(InetSocketAddress(host, port), 800) } }.isSuccess
        }
    }

    /** [extra] and [refused]: see [connect] (the Specialist's flow; CDA Net's uses neither). */
    fun provision(pkg: ProvisionPackage, allowFirmware: String? = null, extra: List<CredentialsDto> = emptyList(), refused: String = REFUSED_CDA): DetectedDto {
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
            connect(pkg, onStage, extra, refused).use { ssh ->
                onStage("Lettura firmware, board e MAC")
                val rb = DeviceCheck.parse(ssh.exec(DeviceCheck.READBACK_COMMAND, 8_000).stdout)
                detected = rb.detected()
                DeviceCheck.verify(rb, pkg.checks, allowFirmware)
                if (DeviceCheck.firmwareMatches(rb.firmware, pkg.checks.firmware)) {
                    onStage("Verificati firmware ${pkg.checks.firmware}, board e MAC ${pkg.summary.mac}")
                } else {
                    // kept on purpose after the update failed: written in the result, so the history shows it
                    onStage("Firmware ${rb.firmware} diverso dal richiesto ${pkg.checks.firmware}: configurazione scritta comunque (aggiornamento non riuscito); verificati board e MAC ${pkg.summary.mac}")
                }

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
