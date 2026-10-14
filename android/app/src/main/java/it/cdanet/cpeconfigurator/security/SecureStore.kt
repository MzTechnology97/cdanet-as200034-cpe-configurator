package it.cdanet.cpeconfigurator.security

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The few secrets that field work needs without Internet (the prepared configuration, the CPE
 * credentials): AES-GCM with a key of the Android Keystore that never leaves it, one file per
 * value in noBackupFilesDir (not in backups). Whoever saves a value also removes it when it is
 * no longer needed or has expired.
 */
class SecureStore(context: Context) {
    private val dir = File(context.noBackupFilesDir, "secure")

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build()
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE).apply { init(spec) }.generateKey()
    }

    private fun file(name: String) = File(dir, "$name.bin")

    @Synchronized
    fun put(name: String, text: String) {
        dir.mkdirs()
        val cipher = Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.ENCRYPT_MODE, key()) }
        val sealed = cipher.doFinal(text.toByteArray(Charsets.UTF_8))
        val tmp = File(dir, "$name.tmp")
        tmp.writeBytes(byteArrayOf(cipher.iv.size.toByte()) + cipher.iv + sealed)
        if (!tmp.renameTo(file(name))) {
            file(name).delete()
            tmp.renameTo(file(name))
        }
    }

    /** The value saved under [name]; null when missing or no longer readable (e.g. the key was reset). */
    @Synchronized
    fun get(name: String): String? = runCatching {
        val bytes = file(name).takeIf { it.isFile }?.readBytes() ?: return null
        val ivLen = bytes[0].toInt()
        val cipher = Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes, 1, ivLen)) }
        String(cipher.doFinal(bytes, 1 + ivLen, bytes.size - 1 - ivLen), Charsets.UTF_8)
    }.getOrNull()

    @Synchronized
    fun remove(name: String) {
        file(name).delete()
    }

    private companion object {
        const val KEYSTORE = "AndroidKeyStore"
        const val ALIAS = "cda_field_store"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
    }
}
