package it.cdanet.cpeconfigurator.firmware

import android.content.Context
import it.cdanet.cpeconfigurator.data.ApiClient
import it.cdanet.cpeconfigurator.data.AppJson
import it.cdanet.cpeconfigurator.data.FirmwareImageDto
import it.cdanet.cpeconfigurator.data.FirmwareListDto
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException
import java.security.MessageDigest

/**
 * The firmware images on the phone: downloaded with Internet, used later on the CPE's Wi-Fi
 * (no Internet there). Each file is checked against the server's SHA-256 before it is kept.
 */
class FirmwareStore(context: Context) {
    private val dir = File(context.filesDir, "firmware")
    private val listFile = File(dir, "list.json")

    fun fileOf(img: FirmwareImageDto) = File(dir, "${img.sha256}.bin")

    fun has(img: FirmwareImageDto) = fileOf(img).let { it.isFile && it.length() == img.size }

    /** Last list received from the server, for the roof without Internet. */
    fun savedList(): FirmwareListDto? = runCatching { AppJson.decodeFromString(FirmwareListDto.serializer(), listFile.readText()) }.getOrNull()

    fun saveList(l: FirmwareListDto) {
        dir.mkdirs()
        listFile.writeText(AppJson.encodeToString(FirmwareListDto.serializer(), l))
        // images no longer offered by the server go away (an old version must not be flashed)
        val keep = l.items.map { "${it.sha256}.bin" }.toSet()
        dir.listFiles()?.filter { it.name.endsWith(".bin") && it.name !in keep }?.forEach { it.delete() }
    }

    suspend fun download(api: ApiClient, img: FirmwareImageDto, onProgress: (Float) -> Unit) = withContext(Dispatchers.IO) {
        dir.mkdirs()
        val tmp = File(dir, "${img.sha256}.part")
        try {
            api.firmwareDownload(img.id, tmp) { done -> onProgress(if (img.size > 0) done.toFloat() / img.size else 0f) }
            if (sha256(tmp) != img.sha256.lowercase()) throw IOException("Firmware scaricato corrotto (checksum diverso): riprova")
            val head = AirosImage.readHead(tmp)
            if (AirosImage.parseHeader(head)?.platform != img.platform) throw IOException("Il file scaricato non è il firmware ${img.platform} atteso")
            if (!tmp.renameTo(fileOf(img))) throw IOException("Impossibile salvare il firmware sul telefono")
        } finally {
            tmp.delete()
        }
    }

    companion object {
        fun sha256(f: File): String = digest(f, "SHA-256")

        fun md5(f: File): String = digest(f, "MD5")

        private fun digest(f: File, alg: String): String {
            val md = MessageDigest.getInstance(alg)
            f.inputStream().use { input ->
                val buf = ByteArray(64 * 1024)
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    md.update(buf, 0, n)
                }
            }
            return md.digest().joinToString("") { "%02x".format(it) }
        }
    }
}
