package it.cdanet.cpeconfigurator.ui

import kotlinx.coroutines.launch
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.foundation.clickable
import android.net.Uri
import android.content.Intent
import android.content.ClipboardManager
import android.content.ClipData
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import it.cdanet.cpeconfigurator.R
import it.cdanet.cpeconfigurator.tools.ToolResult
import androidx.annotation.DrawableRes
import androidx.compose.foundation.background
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.painterResource

@Composable
fun SectionCard(title: String? = null, modifier: Modifier = Modifier, @DrawableRes icon: Int? = null, content: @Composable ColumnScope.() -> Unit) {
    Card(
        modifier = modifier.fillMaxWidth().padding(vertical = 6.dp),
        shape = MaterialTheme.shapes.large,
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
    ) {
        Column(Modifier.padding(horizontal = 18.dp, vertical = 16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (title != null) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (icon != null) {
                        Box(Modifier.size(32.dp).clip(RoundedCornerShape(10.dp)).background(MaterialTheme.colorScheme.primaryContainer), contentAlignment = Alignment.Center) {
                            Icon(painterResource(icon), contentDescription = null, tint = MaterialTheme.colorScheme.onPrimaryContainer, modifier = Modifier.size(18.dp))
                        }
                        Spacer(Modifier.width(10.dp))
                    }
                    Text(title, style = MaterialTheme.typography.titleMedium)
                }
            }
            content()
        }
    }
}

enum class NoticeKind { Info, Good, Warn, Bad }

/** Tonal message with a status icon (info, ok, attention, error). */
@Composable
fun Notice(text: String, kind: NoticeKind, onDismiss: (() -> Unit)? = null) {
    val st = StatusPalette
    val (fg, bg, icon) = when (kind) {
        NoticeKind.Good -> Triple(st.good, st.goodContainer, R.drawable.ic_check_circle_filled)
        NoticeKind.Warn -> Triple(st.warn, st.warnContainer, R.drawable.ic_warning_filled)
        NoticeKind.Bad -> Triple(st.bad, st.badContainer, R.drawable.ic_error_filled)
        NoticeKind.Info -> Triple(MaterialTheme.colorScheme.onSecondaryContainer, MaterialTheme.colorScheme.secondaryContainer, R.drawable.ic_info_filled)
    }
    Row(
        Modifier.fillMaxWidth().padding(vertical = 4.dp).clip(MaterialTheme.shapes.medium).background(bg).padding(start = 14.dp, end = 8.dp, top = 12.dp, bottom = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(painterResource(icon), contentDescription = null, tint = fg, modifier = Modifier.size(22.dp))
        Spacer(Modifier.width(12.dp))
        Text(text, color = if (kind == NoticeKind.Info) fg else MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f).padding(end = 6.dp))
        if (onDismiss != null) TextButton(onClick = onDismiss) { Text("OK") }
    }
}

/** Status message in a given color: rendered as a [Notice] of the matching kind. */
@Composable
fun Banner(text: String, color: Color, onDismiss: (() -> Unit)? = null) {
    val st = StatusPalette
    val kind = when (color) {
        st.good -> NoticeKind.Good
        st.warn -> NoticeKind.Warn
        st.bad, MaterialTheme.colorScheme.error -> NoticeKind.Bad
        else -> NoticeKind.Info
    }
    Notice(text, kind, onDismiss)
}

@Composable
fun ErrorBanner(text: String?, onDismiss: (() -> Unit)? = null) {
    if (!text.isNullOrBlank()) Banner(text, MaterialTheme.colorScheme.error, onDismiss)
}

@Composable
fun BusyButton(text: String, busy: Boolean, modifier: Modifier = Modifier, enabled: Boolean = true, primary: Boolean = true, tonal: Boolean = false, onClick: () -> Unit) {
    val content: @Composable () -> Unit = {
        if (busy) {
            CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
            Spacer(Modifier.width(10.dp))
        }
        Text(text)
    }
    if (primary) {
        Button(onClick = onClick, enabled = enabled && !busy, modifier = modifier.heightIn(min = 48.dp)) { content() }
    } else if (tonal) {
        androidx.compose.material3.FilledTonalButton(
            onClick = onClick,
            enabled = enabled && !busy,
            modifier = modifier.heightIn(min = 48.dp),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 12.dp),
        ) { content() }
    } else {
        OutlinedButton(onClick = onClick, enabled = enabled && !busy, modifier = modifier.heightIn(min = 48.dp)) { content() }
    }
}

@Composable
fun Field(
    label: String,
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    password: Boolean = false,
    keyboardType: KeyboardType = KeyboardType.Text,
    placeholder: String? = null,
    supporting: String? = null,
    isError: Boolean = false,
    readOnly: Boolean = false,
    trailing: (@Composable () -> Unit)? = null,
    @DrawableRes leadingIcon: Int? = null,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text(label) },
        placeholder = if (placeholder != null) { { Text(placeholder) } } else null,
        supportingText = if (supporting != null) { { Text(supporting) } } else null,
        isError = isError,
        readOnly = readOnly,
        singleLine = true,
        trailingIcon = trailing,
        leadingIcon = leadingIcon?.let { { Icon(painterResource(it), contentDescription = null, modifier = Modifier.size(20.dp)) } },
        shape = MaterialTheme.shapes.medium,
        visualTransformation = if (password) PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
        keyboardOptions = KeyboardOptions(keyboardType = if (password) KeyboardType.Password else keyboardType),
        modifier = modifier.fillMaxWidth(),
    )
}

@Composable
fun <T> Dropdown(label: String, options: List<T>, selected: T, display: (T) -> String, onSelect: (T) -> Unit, modifier: Modifier = Modifier) {
    var open by remember { mutableStateOf(false) }
    Box(modifier) {
        OutlinedButton(onClick = { open = true }, modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.weight(1f)) {
                Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(display(selected), style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurface)
            }
            Icon(Icons.Filled.ArrowDropDown, contentDescription = null)
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            options.forEach { o ->
                DropdownMenuItem(text = { Text(display(o)) }, onClick = {
                    onSelect(o)
                    open = false
                })
            }
        }
    }
}

@Composable
fun KeyValue(key: String, value: String) {
    Row(Modifier.fillMaxWidth().padding(vertical = 3.dp)) {
        Text(key, modifier = Modifier.weight(0.42f), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
        Text(value, modifier = Modifier.weight(0.58f), style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
    }
}

@Composable
fun ToolResultView(result: ToolResult, onPorts: (suspend (String) -> String)? = null) {
    if (result.items.any { it.host != null }) {
        DeviceListView(result, onPorts)
        return
    }
    result.rows.forEach { (k, v) -> KeyValue(k, v) }
    if (result.items.isNotEmpty()) {
        HorizontalDivider(Modifier.padding(vertical = 6.dp))
        result.items.forEach { item ->
            Row(Modifier.fillMaxWidth().padding(vertical = 5.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(item.title, fontWeight = FontWeight.Medium)
                    if (item.subtitle.isNotBlank()) Text(item.subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (item.trailing.isNotBlank()) Text(item.trailing, style = MaterialTheme.typography.labelLarge)
            }
        }
    }
    result.note?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
}

/** Devices found on the LAN: one dense row each (IP and name, kind, vendor/MAC), actions on tap. */
@Composable
private fun DeviceListView(result: ToolResult, onPorts: (suspend (String) -> String)?) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val ports = remember { mutableStateMapOf<String, String>() }
    var open by remember { mutableStateOf<String?>(null) }
    var query by remember { mutableStateOf("") }
    Text(result.rows.joinToString(" · ") { (k, v) -> "$k $v" }, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    if (result.items.size > 10) {
        OutlinedTextField(query, { query = it }, Modifier.fillMaxWidth(), singleLine = true, placeholder = { Text("Cerca IP, nome, produttore, MAC") })
    }
    val q = query.trim().lowercase()
    val shown = result.items.filter { q.isEmpty() || "${it.title} ${it.subtitle} ${it.tag}".lowercase().contains(q) }
    shown.forEachIndexed { i, item ->
        if (i > 0) HorizontalDivider()
        val key = item.host ?: item.title
        val expanded = open == key
        Column(Modifier.fillMaxWidth().clickable { open = if (expanded) null else key }.padding(vertical = 6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(item.title, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                if (item.trailing.isNotBlank()) Text(item.trailing, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            val line = listOf(item.tag, item.subtitle).filter { it.isNotBlank() }.joinToString(" · ")
            if (line.isNotBlank()) {
                Text(line, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = if (expanded) 4 else 1, overflow = TextOverflow.Ellipsis)
            }
            val host = item.host
            if (expanded && host != null) {
                Row {
                    TextButton(onClick = { runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("http://$host"))) } }) { Text("Apri web") }
                    TextButton(onClick = { context.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText("IP", host)) }) { Text("Copia IP") }
                    if (onPorts != null) TextButton(onClick = {
                        ports[host] = "verifica delle porte…"
                        scope.launch { ports[host] = runCatching { onPorts(host) }.getOrElse { it.message ?: "verifica non riuscita" } }
                    }) { Text("Porte") }
                }
                ports[host]?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
            }
        }
    }
    if (q.isNotEmpty() && shown.isEmpty()) Text("Nessun dispositivo con questa ricerca.", style = MaterialTheme.typography.bodySmall)
    result.note?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
}

@Composable
fun MonoBlock(text: String) {
    Text(text, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall)
}

/** Small status pill: a dot and a short label in the status color. */
@Composable
fun StatusChip(text: String, kind: NoticeKind, modifier: Modifier = Modifier) {
    val st = StatusPalette
    val (fg, bg) = when (kind) {
        NoticeKind.Good -> st.good to st.goodContainer
        NoticeKind.Warn -> st.warn to st.warnContainer
        NoticeKind.Bad -> st.bad to st.badContainer
        NoticeKind.Info -> MaterialTheme.colorScheme.onSurfaceVariant to MaterialTheme.colorScheme.surfaceContainerHighest
    }
    Row(
        modifier.clip(RoundedCornerShape(50)).background(bg).padding(horizontal = 10.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(7.dp).clip(RoundedCornerShape(50)).background(fg))
        Spacer(Modifier.width(6.dp))
        Text(text, color = fg, style = MaterialTheme.typography.labelMedium, maxLines = 1)
    }
}

/** Summary line of a list screen with a compact refresh action (spinner while loading). */
@Composable
fun ListHeader(summary: String, busy: Boolean, onRefresh: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(summary, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
        RefreshButton(busy, onRefresh)
    }
}

/** Round tonal refresh button; shows a spinner while loading. */
@Composable
fun RefreshButton(busy: Boolean, onRefresh: () -> Unit) {
    androidx.compose.material3.FilledTonalIconButton(onClick = onRefresh, enabled = !busy) {
        if (busy) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
        else Icon(painterResource(R.drawable.ic_refresh), contentDescription = "Aggiorna", modifier = Modifier.size(20.dp))
    }
}

/** Friendly empty list: a big tonal icon, a title and an optional hint. */
@Composable
fun EmptyState(@DrawableRes icon: Int, title: String, hint: String? = null) {
    Column(Modifier.fillMaxWidth().padding(vertical = 28.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Box(Modifier.size(72.dp).clip(RoundedCornerShape(24.dp)).background(MaterialTheme.colorScheme.surfaceContainerHigh), contentAlignment = Alignment.Center) {
            Icon(painterResource(icon), contentDescription = null, tint = MaterialTheme.colorScheme.outline, modifier = Modifier.size(36.dp))
        }
        Text(title, style = MaterialTheme.typography.titleMedium, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        if (hint != null) Text(hint, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
    }
}

/** One line of a check list (diagnosis, verification, acceptance): status icon, title, detail. */
@Composable
fun CheckRow(title: String, verdict: it.cdanet.cpeconfigurator.field.Verdict, detail: String) {
    val st = StatusPalette
    val (fg, bg, icon) = when (verdict) {
        it.cdanet.cpeconfigurator.field.Verdict.Ok -> Triple(st.good, st.goodContainer, R.drawable.ic_check_circle_filled)
        it.cdanet.cpeconfigurator.field.Verdict.Warn -> Triple(st.warn, st.warnContainer, R.drawable.ic_warning_filled)
        it.cdanet.cpeconfigurator.field.Verdict.Bad -> Triple(st.bad, st.badContainer, R.drawable.ic_error_filled)
        it.cdanet.cpeconfigurator.field.Verdict.Info -> Triple(MaterialTheme.colorScheme.outline, MaterialTheme.colorScheme.surfaceContainerHigh, R.drawable.ic_info)
    }
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.Top) {
        Box(Modifier.size(30.dp).clip(RoundedCornerShape(50)).background(bg), contentAlignment = Alignment.Center) {
            Icon(painterResource(icon), contentDescription = null, tint = fg, modifier = Modifier.size(18.dp))
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f).padding(top = 4.dp)) {
            Text(title, style = MaterialTheme.typography.titleSmall)
            if (detail.isNotBlank()) Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/**
 * Keeps the display on while shown: pointing on the roof with the hands on the antenna, the
 * screen must not go dark. Counted per window, so overlapping screens (transitions, tabs) work.
 */
@Composable
fun KeepScreenOn() {
    val view = androidx.compose.ui.platform.LocalView.current
    androidx.compose.runtime.DisposableEffect(view) {
        val n = (view.getTag(R.id.keep_screen_on_count) as? Int ?: 0) + 1
        view.setTag(R.id.keep_screen_on_count, n)
        view.keepScreenOn = true
        onDispose {
            val left = (view.getTag(R.id.keep_screen_on_count) as? Int ?: 1) - 1
            view.setTag(R.id.keep_screen_on_count, left)
            if (left <= 0) view.keepScreenOn = false
        }
    }
}
