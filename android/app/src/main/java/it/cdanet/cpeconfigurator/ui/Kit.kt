package it.cdanet.cpeconfigurator.ui

import androidx.annotation.DrawableRes
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonColors
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import it.cdanet.cpeconfigurator.R
import it.cdanet.cpeconfigurator.field.Verdict

/**
 * The components of the console (console/src/ui) for the app: the same tones, tiles, segmented
 * control and badges, built on the tokens of Theme.kt. Screens use these instead of styling their
 * own, so the app and the console look like one product.
 */

/** The tones of the console: a strong colour for text and icons, a soft one behind them. */
enum class Tone { Neutral, Good, Warn, Bad, Info, Brand }

@Immutable
data class ToneColors(val content: Color, val container: Color)

val Tone.colors: ToneColors
    @Composable @ReadOnlyComposable get() {
        val st = StatusPalette
        val cs = MaterialTheme.colorScheme
        return when (this) {
            Tone.Neutral -> ToneColors(cs.onSurfaceVariant, cs.surfaceContainerHigh)
            Tone.Good -> ToneColors(st.good, st.goodContainer)
            Tone.Warn -> ToneColors(st.warn, st.warnContainer)
            Tone.Bad -> ToneColors(st.bad, st.badContainer)
            Tone.Info -> ToneColors(st.info, st.infoContainer)
            Tone.Brand -> ToneColors(cs.primary, cs.primaryContainer)
        }
    }

val NoticeKind.tone: Tone
    get() = when (this) {
        NoticeKind.Info -> Tone.Info
        NoticeKind.Good -> Tone.Good
        NoticeKind.Warn -> Tone.Warn
        NoticeKind.Bad -> Tone.Bad
    }

val Verdict.tone: Tone
    get() = when (this) {
        Verdict.Ok -> Tone.Good
        Verdict.Warn -> Tone.Warn
        Verdict.Bad -> Tone.Bad
        Verdict.Info -> Tone.Neutral
    }

/** The border of the console's cards and tiles (--line). */
@Composable
@ReadOnlyComposable
fun cardBorder() = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant)

/**
 * A number with its label, as the console's Stat. With [onClick] it is also a filter: [active]
 * paints it in its tone. [icon] adds the small tonal square of the home tiles; [compact] fits four
 * in a row on a phone.
 */
@Composable
fun StatTile(
    label: String,
    value: String?,
    modifier: Modifier = Modifier,
    tone: Tone = Tone.Neutral,
    hint: String? = null,
    active: Boolean = false,
    @DrawableRes icon: Int? = null,
    compact: Boolean = false,
    onClick: (() -> Unit)? = null,
) {
    val t = tone.colors
    val shape = MaterialTheme.shapes.large
    val base = modifier
        .shadow(if (active) 0.dp else 1.dp, shape, clip = false)
        .clip(shape)
        .background(if (active) t.container else MaterialTheme.colorScheme.surfaceContainerLow)
        .border(BorderStroke(1.dp, if (active) t.content else MaterialTheme.colorScheme.outlineVariant), shape)
    val clickable = if (onClick != null) base.selectable(selected = active, role = Role.Tab, onClick = onClick) else base
    Column(clickable.padding(if (compact) 10.dp else ConsoleTokens.SPACE_4.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                value ?: "—",
                style = if (compact) MaterialTheme.typography.titleLarge else MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.Bold,
                color = if (tone == Tone.Neutral) MaterialTheme.colorScheme.onSurface else t.content,
                maxLines = 1,
                modifier = Modifier.weight(1f),
            )
            if (icon != null) {
                Box(Modifier.size(36.dp).clip(MaterialTheme.shapes.medium).background(t.container), contentAlignment = Alignment.Center) {
                    Icon(painterResource(icon), contentDescription = null, tint = t.content, modifier = Modifier.size(20.dp))
                }
            }
        }
        Text(
            label,
            style = if (compact) MaterialTheme.typography.labelMedium else MaterialTheme.typography.labelLarge,
            color = if (active) t.content else MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = if (compact) 1 else 2,
            overflow = TextOverflow.Ellipsis,
        )
        if (hint != null) Text(hint, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/**
 * One choice among a few, side by side (views, filters), as the console's segmented control: a
 * grey track with the chosen one raised on it. Scrolls sideways when the labels do not fit.
 */
@Composable
fun <T> Segmented(options: List<Pair<T, String>>, selected: T, onSelect: (T) -> Unit, modifier: Modifier = Modifier, fill: Boolean = true) {
    val track = RoundedCornerShape(ConsoleTokens.RADIUS_SM.dp)
    val item = RoundedCornerShape(6.dp)
    Row(
        modifier
            .then(if (fill) Modifier.fillMaxWidth() else Modifier)
            .clip(track)
            .background(MaterialTheme.colorScheme.surfaceContainerHigh)
            .then(if (fill) Modifier else Modifier.horizontalScroll(rememberScrollState()))
            .padding(3.dp),
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        options.forEach { (value, label) ->
            val on = value == selected
            Box(
                (if (fill) Modifier.weight(1f) else Modifier)
                    .then(if (on) Modifier.shadow(1.dp, item) else Modifier)
                    .clip(item)
                    .background(if (on) MaterialTheme.colorScheme.surfaceContainerLow else Color.Transparent)
                    .selectable(selected = on, role = Role.Tab) { onSelect(value) }
                    .padding(horizontal = 14.dp, vertical = 10.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    label,
                    style = MaterialTheme.typography.labelLarge,
                    color = if (on) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

/** The main action, as the console's primary button: brand colour, corners of 8, a finger high. */
@Composable
fun PrimaryButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    colors: ButtonColors = ButtonDefaults.buttonColors(),
    contentPadding: PaddingValues = ButtonDefaults.ContentPadding,
    content: @Composable RowScope.() -> Unit,
) = Button(onClick, modifier.heightIn(min = 48.dp), enabled, MaterialTheme.shapes.small, colors, contentPadding = contentPadding, content = content)

/** The other actions, as the console's secondary button: ink on the card, a stronger line around. */
@Composable
fun SecondaryButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    contentPadding: PaddingValues = ButtonDefaults.ContentPadding,
    content: @Composable RowScope.() -> Unit,
) = OutlinedButton(
    onClick,
    modifier.heightIn(min = 48.dp),
    enabled,
    MaterialTheme.shapes.small,
    ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.onSurface),
    border = BorderStroke(1.dp, if (enabled) MaterialTheme.colorScheme.outline else MaterialTheme.colorScheme.outlineVariant),
    contentPadding = contentPadding,
    content = content,
)

/** A short label in a pill of its tone, as the console's Badge. */
@Composable
fun Badge(text: String, tone: Tone = Tone.Neutral, modifier: Modifier = Modifier) {
    val t = tone.colors
    Text(
        text,
        color = t.content,
        style = MaterialTheme.typography.labelMedium,
        fontWeight = FontWeight.Bold,
        maxLines = 1,
        modifier = modifier.clip(RoundedCornerShape(50)).background(t.container).padding(horizontal = 10.dp, vertical = 3.dp),
    )
}

/**
 * Every component of the app on one page, in the current theme (the console has the same at #/ui):
 * to check them side by side after a change of the tokens. Only in debug builds.
 */
@Composable
fun ComponentsShowcase() {
    var view by remember { mutableStateOf("list") }
    var filter by remember { mutableStateOf(Tone.Neutral) }
    var text by remember { mutableStateOf("") }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SectionCard("Riquadri dei numeri", icon = R.drawable.ic_info) {
            Row(horizontalArrangement = Arrangement.spacedBy(ConsoleTokens.SPACE_3.dp)) {
                StatTile("tutte", "128", Modifier.weight(1f), active = filter == Tone.Neutral) { filter = Tone.Neutral }
                StatTile("online", "119", Modifier.weight(1f), tone = Tone.Good, active = filter == Tone.Good) { filter = Tone.Good }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(ConsoleTokens.SPACE_3.dp)) {
                StatTile("con problemi", "6", Modifier.weight(1f), tone = Tone.Warn, active = filter == Tone.Warn) { filter = Tone.Warn }
                StatTile("offline", "3", Modifier.weight(1f), tone = Tone.Bad, hint = "da 2 ore", active = filter == Tone.Bad) { filter = Tone.Bad }
            }
            StatTile("da completare", "2", Modifier.fillMaxWidth(), tone = Tone.Brand, icon = R.drawable.ic_refresh)
        }
        SectionCard("Selettore") {
            Segmented(listOf("list" to "Elenco", "grid" to "Griglia IP", "topo" to "Topologia"), view, { view = it })
        }
        SectionCard("Pulsanti") {
            BusyButton("Principale", false, Modifier.fillMaxWidth()) {}
            BusyButton("Secondario", false, Modifier.fillMaxWidth(), primary = false) {}
            BusyButton("Tonale", false, Modifier.fillMaxWidth(), primary = false, tonal = true) {}
            BusyButton("In corso", true, Modifier.fillMaxWidth()) {}
        }
        SectionCard("Badge ed etichette") {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Tone.entries.forEach { Badge(it.name.lowercase(), it) }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                NoticeKind.entries.forEach { StatusChip(it.name.lowercase(), it) }
            }
        }
        SectionCard("Avvisi") {
            Notice("Il collaudo è stato accettato dal NOC.", NoticeKind.Good, title = "Collaudo accettato")
            Notice("Segnale sotto -70 dBm: ripunta l'antenna.", NoticeKind.Warn)
            Notice("La CPE non risponde su 192.168.1.20.", NoticeKind.Bad)
            Notice("I dati arrivano dall'ultima copia, di 5 minuti fa.", NoticeKind.Info)
        }
        SectionCard("Campi") {
            Field("Nome del cliente", text, { text = it }, placeholder = "Mario Rossi")
            Field("SSID", "CDA-NET-N26-D06", {}, isError = true, supporting = "Il formato è CDA-NET-N{nodo}-D{distretto}")
        }
        SectionCard("Esiti delle verifiche") {
            CheckRow("Segnale", Verdict.Ok, "-58 dBm, buono")
            CheckRow("Capacità", Verdict.Warn, "70 Mbps, sotto l'atteso")
            CheckRow("PPPoE", Verdict.Bad, "autenticazione rifiutata")
            CheckRow("Firmware", Verdict.Info, "8.7.4")
        }
        SectionCard("Elenco vuoto e caricamento") {
            EmptyState(R.drawable.ic_check_circle_filled, "Nessun guasto attivo", "Le segnalazioni compaiono qui.")
            SkeletonRows(2)
        }
    }
}
