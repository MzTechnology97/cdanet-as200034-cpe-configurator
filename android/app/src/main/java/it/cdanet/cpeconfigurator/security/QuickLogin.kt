package it.cdanet.cpeconfigurator.security

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import kotlinx.coroutines.suspendCancellableCoroutine
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

class QuickLoginCancelled(message: String) : Exception(message)

/**
 * Quick login with fingerprint or face. No password is stored: the server gives this phone a
 * revocable device key, encrypted here with an Android keystore key.
 * - Strong biometrics (fingerprint, 3D face): the keystore key itself unlocks only after the
 *   biometric prompt (CryptoObject).
 * - Weak biometrics (the face unlock of most phones): the prompt gates the use of the key, which
 *   still never leaves the keystore.
 */
class QuickLogin(private val context: Context) {
    data class Saved(val backend: String, val username: String, val deviceId: String, val iv: String, val data: String, val strong: Boolean)

    private val prefs = context.getSharedPreferences("quick_login", Context.MODE_PRIVATE)

    fun saved(): Saved? {
        val id = prefs.getString("deviceId", null) ?: return null
        return Saved(
            backend = prefs.getString("backend", "").orEmpty(),
            username = prefs.getString("username", "").orEmpty(),
            deviceId = id,
            iv = prefs.getString("iv", "").orEmpty(),
            data = prefs.getString("data", "").orEmpty(),
            strong = prefs.getBoolean("strong", true),
        )
    }

    /** The user answered "Non ora": not asked again after each login (Settings can still turn it on). */
    fun declined(username: String): Boolean = prefs.getBoolean("declined_$username", false)

    fun decline(username: String) = prefs.edit().putBoolean("declined_$username", true).apply()

    fun clear() {
        val declined = prefs.all.filterKeys { it.startsWith("declined_") }
        val editor = prefs.edit().clear()
        declined.forEach { (k, v) -> if (v is Boolean) editor.putBoolean(k, v) }
        editor.apply()
        runCatching {
            val ks = KeyStore.getInstance(KEYSTORE).apply { load(null) }
            ks.deleteEntry(ALIAS_STRONG)
            ks.deleteEntry(ALIAS_WEAK)
        }
    }

    /** The biometric class the phone offers (strong first), or null when none is enrolled. */
    fun capability(): Int? {
        val bm = BiometricManager.from(context)
        return when {
            bm.canAuthenticate(BIOMETRIC_STRONG) == BiometricManager.BIOMETRIC_SUCCESS -> BIOMETRIC_STRONG
            bm.canAuthenticate(BIOMETRIC_WEAK) == BiometricManager.BIOMETRIC_SUCCESS -> BIOMETRIC_WEAK
            else -> null
        }
    }

    private fun key(strong: Boolean): SecretKey {
        val ks = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        val alias = if (strong) ALIAS_STRONG else ALIAS_WEAK
        (ks.getKey(alias, null) as? SecretKey)?.let { return it }
        val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .apply {
                if (strong) {
                    setUserAuthenticationRequired(true)
                    setInvalidatedByBiometricEnrollment(true)
                    if (Build.VERSION.SDK_INT >= 30) setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
                }
            }
            .build()
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE).apply { init(spec) }.generateKey()
    }

    fun encryptCipher(strong: Boolean): Cipher = Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.ENCRYPT_MODE, key(strong)) }

    /** null when a new fingerprint/face was enrolled (the key is gone): quick login must be set up again. */
    fun decryptCipher(s: Saved): Cipher? = try {
        Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.DECRYPT_MODE, key(s.strong), GCMParameterSpec(128, Base64.decode(s.iv, Base64.NO_WRAP))) }
    } catch (_: KeyPermanentlyInvalidatedException) {
        clear()
        null
    }

    fun save(backend: String, username: String, deviceId: String, secret: String, cipher: Cipher, strong: Boolean) {
        val data = cipher.doFinal(secret.toByteArray(Charsets.UTF_8))
        prefs.edit()
            .putString("backend", backend)
            .putString("username", username)
            .putString("deviceId", deviceId)
            .putString("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .putString("data", Base64.encodeToString(data, Base64.NO_WRAP))
            .putBoolean("strong", strong)
            .apply()
    }

    fun secret(s: Saved, cipher: Cipher): String = String(cipher.doFinal(Base64.decode(s.data, Base64.NO_WRAP)), Charsets.UTF_8)

    /** System biometric prompt; returns the cipher to use (unlocked by the prompt for strong keys). */
    suspend fun authenticate(activity: FragmentActivity, title: String, subtitle: String, strong: Boolean, cipher: Cipher): Cipher =
        suspendCancellableCoroutine { cont ->
            val prompt = BiometricPrompt(
                activity,
                ContextCompat.getMainExecutor(activity),
                object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                        if (cont.isActive) cont.resume(result.cryptoObject?.cipher ?: cipher)
                    }

                    override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                        if (cont.isActive) cont.resumeWithException(QuickLoginCancelled(errString.toString()))
                    }
                },
            )
            val info = BiometricPrompt.PromptInfo.Builder()
                .setTitle(title)
                .setSubtitle(subtitle)
                .setAllowedAuthenticators(if (strong) BIOMETRIC_STRONG else BIOMETRIC_WEAK)
                .setNegativeButtonText("Usa la password")
                .build()
            if (strong) prompt.authenticate(info, BiometricPrompt.CryptoObject(cipher)) else prompt.authenticate(info)
            cont.invokeOnCancellation { prompt.cancelAuthentication() }
        }

    companion object {
        private const val KEYSTORE = "AndroidKeyStore"
        private const val ALIAS_STRONG = "cdanet_quick_login_strong"
        private const val ALIAS_WEAK = "cdanet_quick_login"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
    }
}
