package it.cdanet.cpeconfigurator.field

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Handler
import android.os.Looper
import kotlin.math.PI
import kotlin.math.sin

/**
 * Short beep whose pitch follows the signal, so the antenna can be aligned while looking
 * at the AP instead of the phone (higher pitch = better signal).
 */
class AlignmentTone {
    private val rate = 22_050
    private val main = Handler(Looper.getMainLooper())

    fun beep(signal: Int?, durationMs: Int = 120) {
        val hz = FieldDiagnosis.toneHz(signal)
        val n = rate * durationMs / 1000
        val pcm = ShortArray(n) { i ->
            // 5 ms fade in/out avoids clicks
            val env = minOf(1.0, i / (rate * 0.005), (n - i) / (rate * 0.005))
            (sin(2 * PI * hz * i / rate) * env * Short.MAX_VALUE * 0.6).toInt().toShort()
        }
        val track = AudioTrack.Builder()
            .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
            .setAudioFormat(AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(rate).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
            .setBufferSizeInBytes(n * 2)
            .setTransferMode(AudioTrack.MODE_STATIC)
            .build()
        runCatching {
            track.write(pcm, 0, n)
            track.play()
            main.postDelayed({ runCatching { track.release() } }, durationMs + 150L)
        }.onFailure { track.release() }
    }
}
