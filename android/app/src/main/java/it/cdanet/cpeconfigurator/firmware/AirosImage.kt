package it.cdanet.cpeconfigurator.firmware

/** "XC.qca956x.v8.7.4.45112.210415.1103": hardware platform, version and the whole build string. */
data class AirosBuild(val platform: String, val version: String, val build: String)

/** Pure checks on airOS images and on what the CPE reports (unit-tested on the JVM). */
object AirosImage {
    private val BUILD = Regex("""^([A-Z0-9]{1,8})\.([A-Za-z0-9_-]{1,32})\.v(\d+\.\d+\.\d+)(?:[.-][A-Za-z0-9._-]*)?$""")

    /** First line of /etc/version on the CPE, or the build string in an image header. */
    fun parseBuild(text: String): AirosBuild? {
        val s = text.trim().split(Regex("\\s+")).firstOrNull().orEmpty()
        val m = BUILD.matchEntire(s) ?: return null
        return AirosBuild(m.groupValues[1], m.groupValues[3], s)
    }

    /** Header of a firmware file: "UBNT" and the build string (null = not an airOS image). */
    fun parseHeader(head: ByteArray): AirosBuild? {
        if (head.size < 8 || String(head, 0, 4, Charsets.ISO_8859_1) != "UBNT") return null
        val raw = head.copyOfRange(4, minOf(head.size, 4 + 256))
        val end = raw.indexOf(0.toByte()).let { if (it < 0) raw.size else it }
        return parseBuild(String(raw, 0, end, Charsets.ISO_8859_1))
    }

    /** The first bytes of a file, enough for the header. */
    fun readHead(f: java.io.File): ByteArray = f.inputStream().use { input ->
        val buf = ByteArray(260)
        var n = 0
        while (n < buf.size) {
            val r = input.read(buf, n, buf.size - n)
            if (r < 0) break
            n += r
        }
        buf.copyOf(n)
    }

    /** Free KB of /tmp from `df -k /tmp` (busybox layout), null when unreadable. */
    fun freeKb(df: String): Long? =
        df.lineSequence().map { it.trim() }.filter { it.isNotEmpty() && !it.startsWith("Filesystem") }.lastOrNull()
            ?.split(Regex("\\s+"))?.let { cols -> cols.getOrNull(cols.size - 3)?.toLongOrNull() }

    /** Why [image] may not go on a CPE running [cpe] (different platform, unreadable), null when it may. */
    fun refusal(cpe: AirosBuild?, image: AirosBuild?): String? = when {
        image == null -> "Il file sul telefono non è un firmware airOS valido: scaricalo di nuovo"
        cpe == null -> "Versione della CPE non leggibile: aggiornamento bloccato"
        cpe.platform != image.platform -> "La CPE è di piattaforma ${cpe.platform}, il firmware è per ${image.platform}: aggiornamento bloccato"
        else -> null
    }
}
