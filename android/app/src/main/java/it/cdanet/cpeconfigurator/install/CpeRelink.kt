package it.cdanet.cpeconfigurator.install

import it.cdanet.cpeconfigurator.network.Ip
import it.cdanet.cpeconfigurator.provisioning.DeviceCheck
import it.cdanet.cpeconfigurator.ssh.SshConnection
import java.io.IOException

/**
 * Moves a CPE to another AP: the station SSID and its WPA2 key in airOS system.cfg.
 * A "Lock to AP" (BSSID lock) left from a previous pointing would keep the CPE on the old AP,
 * so it is released (or set to the chosen AP). Pure, unit-tested.
 */
object SystemCfgRelink {
    private val SSID_KEYS = listOf(Regex("""^wireless\.\d+\.ssid$"""), Regex("""^wpasupplicant\.profile\.\d+\.network\.\d+\.ssid$"""))
    private val PSK_KEY = Regex("""^wpasupplicant\.profile\.\d+\.network\.\d+\.psk$""")
    private val LOCK_KEYS = listOf(Regex("""^wireless\.\d+\.ap$"""), Regex("""^wpasupplicant\.profile\.\d+\.network\.\d+\.bssid$"""))

    data class Result(val text: String, val ssidLines: Int, val pskLines: Int)

    fun relink(cfg: String, ssid: String, psk: String, lockMac: String? = null): Result {
        require(listOf(ssid, psk, lockMac.orEmpty()).none { it.contains('\n') || it.contains('\r') }) { "Valori non validi" }
        var ssidLines = 0
        var pskLines = 0
        val out = cfg.split('\n').joinToString("\n") { raw ->
            val line = raw.trimEnd('\r')
            val key = line.substringBefore('=', "")
            when {
                key.isEmpty() -> raw
                SSID_KEYS.any { it.matches(key) } -> "$key=$ssid".also { ssidLines++ }
                PSK_KEY.matches(key) -> "$key=$psk".also { pskLines++ }
                LOCK_KEYS.any { it.matches(key) } -> "$key=${lockMac.orEmpty()}"
                else -> raw
            }
        }
        return Result(out, ssidLines, pskLines)
    }
}

/**
 * Writes the new link into the CPE over SSH: new file next to the running one, size and checksum
 * verified, then swapped, saved in flash (cfgmtd) and the CPE rebooted. Must run with the process
 * bound to the Wi-Fi network (NetworkHelper.onWifi).
 */
class CpeRelinker(private val onStage: (String) -> Unit) {
    fun relink(host: String, ports: List<Int>, username: String, password: String, ssid: String, psk: String, lockMac: String?) {
        require(Ip.isPrivate(host)) { "La CPE deve avere un indirizzo privato" }
        onStage("Connessione SSH a $host")
        connect(host, ports, username, password).use { ssh ->
            val current = ssh.exec("cat /tmp/system.cfg", 8_000)
            if (current.exitCode != 0 || current.stdout.isBlank()) throw IOException("Configurazione della CPE non leggibile")
            val r = SystemCfgRelink.relink(current.stdout, ssid, psk, lockMac)
            if (r.ssidLines == 0 || r.pskLines == 0) throw IOException("Configurazione della CPE non riconosciuta: SSID o chiave WPA2 della station non trovati")
            onStage("Nuovo SSID $ssid preparato")
            val bytes = r.text.toByteArray(Charsets.UTF_8)
            val write = ssh.exec("umask 077; cat > /tmp/system.cfg.new", 15_000, stdin = bytes)
            if (write.exitCode != 0) throw IOException("Scrittura della configurazione fallita: ${write.stderr.take(200)}")
            val check = ssh.exec("wc -c < /tmp/system.cfg.new; md5sum /tmp/system.cfg.new 2>/dev/null", 8_000).stdout
            if (check.lineSequence().firstOrNull()?.trim()?.toIntOrNull() != bytes.size) throw IOException("Configurazione trasferita in modo incompleto")
            Regex("""\b([0-9a-f]{32})\b""").find(check)?.groupValues?.get(1)?.let { md5 ->
                if (md5 != DeviceCheck.md5Hex(bytes)) throw IOException("Checksum della configurazione non corrispondente")
            }
            val commit = ssh.exec("mv /tmp/system.cfg.new /tmp/system.cfg && ${DeviceCheck.COMMIT_COMMAND}", 30_000)
            if (commit.exitCode != 0) throw IOException("Salvataggio in flash fallito (${commit.exitCode}): ${commit.stderr.take(200)}")
            onStage("Configurazione salvata nella CPE")
            ssh.execDetached("reboot")
            onStage("Riavvio della CPE: si aggancia al nuovo AP in 1-2 minuti")
        }
    }

    /** CDA Net SSH port first, then the factory one; wrong credentials stop at once. */
    private fun connect(host: String, ports: List<Int>, username: String, password: String): SshConnection {
        var last: Exception? = null
        for (p in ports.distinct()) {
            try {
                return SshConnection.connect(host, p, username, password)
            } catch (e: IOException) {
                if (e.message.orEmpty().startsWith("Autenticazione")) throw e
                last = e
            }
        }
        throw last ?: IOException("SSH non raggiungibile su $host")
    }
}
