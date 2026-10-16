package it.cdanet.cpeconfigurator.field

/** The photos of an acceptance test: what each one shows (sent to the server as `type`). */
enum class PhotoType(val key: String, val label: String) {
    Antenna("antenna", "Antenna"),
    Bracket("bracket", "Staffa / palo"),
    Cabling("cabling", "Cablaggio"),
    Router("router", "Router cliente"),
    Other("other", "Altro"),
    ;

    companion object {
        /** The type of a photo from its caption (the buttons' labels); null for a caption typed elsewhere. */
        fun ofCaption(caption: String): PhotoType? = entries.firstOrNull { it.label.equals(caption.trim(), ignoreCase = true) }

        /** The type as the server keeps it ("antenna"…). */
        fun ofKey(key: String?): PhotoType? = entries.firstOrNull { it.key == key }
    }
}

/**
 * The photos an acceptance test must have: all four for a new installation only (decision of
 * 15/10/2026); re-pointings and CPE replacements have none required (they may still be taken).
 */
object PhotoChecklist {
    fun required(newInstall: Boolean): List<PhotoType> =
        if (newInstall) listOf(PhotoType.Antenna, PhotoType.Bracket, PhotoType.Cabling, PhotoType.Router) else emptyList()

    fun missing(have: Collection<PhotoType>, newInstall: Boolean): List<PhotoType> = required(newInstall).filterNot { it in have }

    /** The required ones taken on the roof: all but the customer's router (indoors, at the end). */
    fun roof(newInstall: Boolean): List<PhotoType> = required(newInstall).filterNot { it == PhotoType.Router }

    /** What is still missing before leaving the roof: never a second climb for a photo. */
    fun missingOnRoof(captions: List<String>, newInstall: Boolean): List<PhotoType> {
        val have = captions.mapNotNull { PhotoType.ofCaption(it) }.toSet()
        return roof(newInstall).filterNot { it in have }
    }
}

/**
 * Checks of a new photo, on its grey levels (pure, unit-tested): blurred (low variance of the
 * Laplacian), too dark, the same shot twice (same bytes) or nearly the same scene (difference hash).
 */
object PhotoQuality {
    /** Below this the photo is probably blurred or shaken (grey image of at most 512 px). */
    const val SHARP_MIN = 50.0
    /** Mean grey level (0-255) below this: too dark to see anything. */
    const val DARK_MAX = 35.0
    /** Difference hashes this close: nearly the same picture. */
    const val NEAR_BITS = 5

    data class Check(val sha: String, val sharpness: Double, val brightness: Double, val dhash: Long)

    fun laplacianVariance(g: IntArray, w: Int, h: Int): Double {
        if (w < 3 || h < 3) return 0.0
        var n = 0
        var sum = 0.0
        var sq = 0.0
        for (y in 1 until h - 1) {
            for (x in 1 until w - 1) {
                val i = y * w + x
                val l = (g[i - 1] + g[i + 1] + g[i - w] + g[i + w] - 4 * g[i]).toDouble()
                sum += l
                sq += l * l
                n++
            }
        }
        val mean = sum / n
        return sq / n - mean * mean
    }

    fun brightness(g: IntArray): Double = if (g.isEmpty()) 0.0 else g.average()

    /** 64-bit difference hash: the image reduced to 9×8 cells, one bit per horizontal step. */
    fun dHash(g: IntArray, w: Int, h: Int): Long {
        val cells = DoubleArray(9 * 8)
        for (cy in 0 until 8) {
            for (cx in 0 until 9) {
                val x0 = cx * w / 9
                val x1 = maxOf(x0 + 1, (cx + 1) * w / 9)
                val y0 = cy * h / 8
                val y1 = maxOf(y0 + 1, (cy + 1) * h / 8)
                var s = 0.0
                var n = 0
                for (y in y0 until minOf(y1, h)) for (x in x0 until minOf(x1, w)) {
                    s += g[y * w + x]
                    n++
                }
                cells[cy * 9 + cx] = if (n == 0) 0.0 else s / n
            }
        }
        var bits = 0L
        for (cy in 0 until 8) for (cx in 0 until 8) {
            if (cells[cy * 9 + cx] > cells[cy * 9 + cx + 1]) bits = bits or (1L shl (cy * 8 + cx))
        }
        return bits
    }

    fun hamming(a: Long, b: Long): Int = java.lang.Long.bitCount(a xor b)

    /** The very same photo already added (same bytes): never sent twice. */
    fun duplicate(new: Check, others: List<Check>): Boolean = others.any { it.sha == new.sha }

    /** What may be wrong with a photo, said plainly (empty = fine): the technician retakes or keeps it. */
    fun problems(new: Check, others: List<Check>): List<String> = buildList {
        if (new.brightness < DARK_MAX) add("troppo scura")
        else if (new.sharpness < SHARP_MIN) add("mossa o sfocata")
        if (others.any { it.sha != new.sha && hamming(it.dhash, new.dhash) <= NEAR_BITS }) add("quasi uguale a un'altra foto già fatta")
    }
}
