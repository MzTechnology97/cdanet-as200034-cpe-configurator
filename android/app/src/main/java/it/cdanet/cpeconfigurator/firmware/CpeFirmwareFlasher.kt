package it.cdanet.cpeconfigurator.firmware

import it.cdanet.cpeconfigurator.data.FirmwareImageDto
import it.cdanet.cpeconfigurator.ssh.SshConnection
import kotlinx.coroutines.delay
import java.io.File
import java.io.IOException

/**
 * Flashes an airOS image on the CPE over SSH: checks platform and version from /etc/version,
 * room in /tmp, sends the file, compares the MD5 on the CPE, then starts `fwupdate -m` detached
 * from the SSH session (the CPE writes the flash and reboots on its own: 3-5 minutes).
 */
class CpeFirmwareFlasher(private val onStage: (String) -> Unit) {

    fun readVersion(ssh: SshConnection): AirosBuild? = AirosImage.parseBuild(ssh.exec("cat /etc/version", 8_000).stdout)

    /** Returns the build running before the flash; throws with an Italian message when it must not go on. */
    fun start(ssh: SshConnection, file: File, img: FirmwareImageDto): AirosBuild {
        onStage("Lettura della versione della CPE")
        val cpe = readVersion(ssh)
        val image = AirosImage.parseHeader(AirosImage.readHead(file))
        AirosImage.refusal(cpe, image)?.let { throw IOException(it) }
        cpe!!
        if (cpe.version == img.version) throw AlreadyUpToDate(cpe)
        val free = AirosImage.freeKb(ssh.exec("df -k /tmp", 8_000).stdout)
        if (free != null && free * 1024 < file.length() + 2 * 1024 * 1024) {
            throw IOException("Memoria libera della CPE insufficiente (${free / 1024} MB): riavviala e riprova")
        }
        val md5 = FirmwareStore.md5(file)
        if (md5 != img.md5.lowercase()) throw IOException("Il firmware sul telefono non corrisponde a quello del server: scaricalo di nuovo")
        onStage("Invio del firmware alla CPE (${file.length() / 1024 / 1024} MB)")
        val put = ssh.exec("umask 077; cat > /tmp/fwupdate.bin", 300_000, stdin = file.readBytes())
        if (put.exitCode != 0) throw IOException("Invio del firmware fallito: ${put.stderr.take(200)}")
        val remote = ssh.exec("md5sum /tmp/fwupdate.bin", 30_000).stdout.trim().substringBefore(' ')
        if (remote != md5) {
            ssh.exec("rm -f /tmp/fwupdate.bin", 8_000)
            throw IOException("Il firmware arrivato sulla CPE è diverso da quello inviato: riprova")
        }
        onStage("Scrittura del firmware ${img.version}: NON togliere alimentazione alla CPE")
        // HUP ignored: closing the SSH session must not stop the flash halfway
        ssh.exec(FLASH_COMMAND, 10_000)
        return cpe
    }

    /**
     * Waits for the CPE to come back after the flash ([connect] opens a new SSH session, or throws
     * while the CPE is still rebooting) and returns its new build.
     */
    suspend fun waitBack(connect: suspend () -> SshConnection, maxMs: Long = 9 * 60_000L): AirosBuild? {
        val until = System.currentTimeMillis() + maxMs
        delay(90_000)
        while (System.currentTimeMillis() < until) {
            val build = runCatching { connect().use { readVersion(it) } }.getOrNull()
            if (build != null) return build
            onStage("La CPE si sta riavviando… (se Android ha lasciato la sua Wi-Fi, ricollegati)")
            delay(10_000)
        }
        return null
    }

    class AlreadyUpToDate(val build: AirosBuild) : Exception("La CPE ha già il firmware ${build.version}")

    companion object {
        const val FLASH_COMMAND = "sh -c 'trap \"\" HUP; /sbin/fwupdate -m > /tmp/fwupdate.log 2>&1' </dev/null >/dev/null 2>&1 &"
    }
}
