package it.cdanet.cpeconfigurator.tools

import java.security.MessageDigest

/**
 * crypt(3) as the Ubiquiti discovery reboot needs it: the device sends a salt ("$1$…" MD5 crypt or
 * "$6$…" SHA-512 crypt) and a challenge; the answer is SHA-256(crypt(password, salt) || challenge),
 * so the password never travels. Algorithms as in glibc, ported from ubnt-discovery-next (MIT).
 */
object UbntCrypt {
    private const val ITOA64 = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

    private fun to64(sb: StringBuilder, v0: Int, n: Int) {
        var v = v0
        repeat(n) {
            sb.append(ITOA64[v and 0x3f])
            v = v ushr 6
        }
    }

    private fun b(x: Byte) = x.toInt() and 0xff

    fun md5Crypt(password: String, setting: String): String {
        val magic = "$1$"
        var salt = setting.removePrefix(magic)
        salt = salt.substringBefore('$').take(8)
        val pw = password.toByteArray(Charsets.UTF_8)
        val sl = salt.toByteArray(Charsets.UTF_8)
        fun md5() = MessageDigest.getInstance("MD5")

        val alt = md5().apply { update(pw); update(sl); update(pw) }.digest()
        val ctx = md5().apply { update(pw); update(magic.toByteArray()); update(sl) }
        var pl = pw.size
        while (pl > 0) {
            ctx.update(alt, 0, minOf(16, pl))
            pl -= 16
        }
        var i = pw.size
        while (i != 0) {
            if (i and 1 != 0) ctx.update(0.toByte()) else ctx.update(pw, 0, minOf(1, pw.size))
            i = i shr 1
        }
        var fin = ctx.digest()
        for (r in 0 until 1000) {
            val c = md5()
            if (r and 1 != 0) c.update(pw) else c.update(fin)
            if (r % 3 != 0) c.update(sl)
            if (r % 7 != 0) c.update(pw)
            if (r and 1 != 0) c.update(fin) else c.update(pw)
            fin = c.digest()
        }
        val f = fin
        val sb = StringBuilder(magic).append(salt).append('$')
        to64(sb, (b(f[0]) shl 16) or (b(f[6]) shl 8) or b(f[12]), 4)
        to64(sb, (b(f[1]) shl 16) or (b(f[7]) shl 8) or b(f[13]), 4)
        to64(sb, (b(f[2]) shl 16) or (b(f[8]) shl 8) or b(f[14]), 4)
        to64(sb, (b(f[3]) shl 16) or (b(f[9]) shl 8) or b(f[15]), 4)
        to64(sb, (b(f[4]) shl 16) or (b(f[10]) shl 8) or b(f[5]), 4)
        to64(sb, b(f[11]), 2)
        return sb.toString()
    }

    fun sha512Crypt(password: String, setting: String): String {
        var rest = setting.removePrefix("$6$")
        var rounds = 5000
        var custom = false
        if (rest.startsWith("rounds=")) {
            val end = rest.indexOf('$')
            rest.substring(7, end).toIntOrNull()?.let {
                rounds = it.coerceIn(1000, 999_999_999)
                custom = true
            }
            rest = rest.substring(end + 1)
        }
        val salt = rest.substringBefore('$').take(16)
        val p = password.toByteArray(Charsets.UTF_8)
        val s = salt.toByteArray(Charsets.UTF_8)
        fun sha() = MessageDigest.getInstance("SHA-512")

        val bb = sha().apply { update(p); update(s); update(p) }.digest()
        val a = sha().apply { update(p); update(s) }
        var pl = p.size
        while (pl > 64) {
            a.update(bb)
            pl -= 64
        }
        a.update(bb, 0, pl)
        var i = p.size
        while (i > 0) {
            if (i and 1 != 0) a.update(bb) else a.update(p)
            i = i shr 1
        }
        val aa = a.digest()
        val dp = sha().apply { repeat(p.size) { update(p) } }.digest()
        val pSeq = ByteArray(p.size) { dp[it % 64] }
        val ds = sha().apply { repeat(16 + b(aa[0])) { update(s) } }.digest()
        val sSeq = ByteArray(s.size) { ds[it % 64] }
        var c = aa
        for (r in 0 until rounds) {
            val h = sha()
            if (r and 1 != 0) h.update(pSeq) else h.update(c)
            if (r % 3 != 0) h.update(sSeq)
            if (r % 7 != 0) h.update(pSeq)
            if (r and 1 != 0) h.update(c) else h.update(pSeq)
            c = h.digest()
        }
        val order = arrayOf(
            intArrayOf(0, 21, 42), intArrayOf(22, 43, 1), intArrayOf(44, 2, 23), intArrayOf(3, 24, 45), intArrayOf(25, 46, 4),
            intArrayOf(47, 5, 26), intArrayOf(6, 27, 48), intArrayOf(28, 49, 7), intArrayOf(50, 8, 29), intArrayOf(9, 30, 51),
            intArrayOf(31, 52, 10), intArrayOf(53, 11, 32), intArrayOf(12, 33, 54), intArrayOf(34, 55, 13), intArrayOf(56, 14, 35),
            intArrayOf(15, 36, 57), intArrayOf(37, 58, 16), intArrayOf(59, 17, 38), intArrayOf(18, 39, 60), intArrayOf(40, 61, 19),
            intArrayOf(62, 20, 41),
        )
        val sb = StringBuilder("$6$")
        if (custom) sb.append("rounds=").append(rounds).append('$')
        sb.append(salt).append('$')
        for ((x, y, z) in order) to64(sb, (b(c[x]) shl 16) or (b(c[y]) shl 8) or b(c[z]), 4)
        to64(sb, b(c[63]), 2)
        return sb.toString()
    }

    /** null for the old DES crypt (salt without "$"): devices of 2008, not supported. */
    fun crypt(password: String, salt: String): String? = when {
        salt.startsWith("$6") -> sha512Crypt(password, salt)
        salt.startsWith("$1") -> md5Crypt(password, salt)
        else -> null
    }

    /** TLV 9 of the reboot command. */
    fun challengeResponse(password: String, salt: ByteArray, challenge: ByteArray): ByteArray? {
        val crypted = crypt(password, String(salt, Charsets.ISO_8859_1)) ?: return null
        return MessageDigest.getInstance("SHA-256").apply {
            update(crypted.toByteArray(Charsets.ISO_8859_1))
            update(challenge)
        }.digest()
    }
}
