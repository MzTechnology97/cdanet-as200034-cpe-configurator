package it.cdanet.cpeconfigurator.ui.screens

import android.speech.tts.TextToSpeech
import android.view.HapticFeedbackConstants
import android.view.View
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.dp
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.field.AlignmentTone
import java.util.Locale

/**
 * Feedback while aiming on the roof, with the phone in a pocket or on the mast: beep (pitch follows
 * the signal), the signal read aloud, and a vibration every time a new peak is reached.
 */
class RoofFeedback(private val view: View, private val tts: TextToSpeech?) {
    private val tone = AlignmentTone()
    private var best: Int? = null
    private var lastSpoken: Int? = null
    private var lastSpokenAt = 0L
    var beep = true
    var voice = false
    var haptic = true

    fun sample(signal: Int?) {
        if (beep) tone.beep(signal)
        if (signal == null) return
        // a new peak: one firm tap, so the hand on the antenna knows to stop there
        if (haptic && best != null && signal > best!!) view.post { view.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS) }
        if (best == null || signal > best!!) best = signal
        val now = System.currentTimeMillis()
        val changed = lastSpoken == null || kotlin.math.abs(signal - lastSpoken!!) >= 1
        if (voice && changed && now - lastSpokenAt > 2500) {
            tts?.speak(spoken(signal), TextToSpeech.QUEUE_FLUSH, null, "signal")
            lastSpoken = signal
            lastSpokenAt = now
        }
    }

    fun resetPeak() {
        best = null
    }

    companion object {
        /** "meno sessanta": negative dBm read as Italian words by the speech engine. */
        fun spoken(signal: Int) = if (signal < 0) "meno ${-signal}" else "$signal"
    }
}

/** Beep / Voce / Vibrazione switches, wired to the CPE's live samples while the screen is open. */
@Composable
fun RoofAids(c: AppContainer, onFeedback: (RoofFeedback) -> Unit = {}) {
    val context = LocalContext.current
    val view = LocalView.current
    var beep by rememberSaveable { mutableStateOf(true) }
    var voice by rememberSaveable { mutableStateOf(false) }
    var haptic by rememberSaveable { mutableStateOf(true) }
    var tts by remember { mutableStateOf<TextToSpeech?>(null) }
    DisposableEffect(voice) {
        var engine: TextToSpeech? = null
        if (voice) {
            engine = TextToSpeech(context) { status -> if (status == TextToSpeech.SUCCESS) engine?.language = Locale.ITALIAN }
            tts = engine
        }
        onDispose {
            engine?.shutdown()
            tts = null
        }
    }
    val fb = remember(tts) { RoofFeedback(view, tts) }
    LaunchedEffect(fb, beep, voice, haptic) {
        fb.beep = beep
        fb.voice = voice
        fb.haptic = haptic
        onFeedback(fb)
        c.field.onSample = { s -> fb.sample(s.signal) }
    }
    DisposableEffect(Unit) { onDispose { c.field.onSample = null } }
    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        FilterChip(selected = beep, onClick = { beep = !beep }, label = { Text("Bip") })
        FilterChip(selected = voice, onClick = { voice = !voice }, label = { Text("Voce") })
        FilterChip(selected = haptic, onClick = { haptic = !haptic }, label = { Text("Vibra al picco") })
    }
}
