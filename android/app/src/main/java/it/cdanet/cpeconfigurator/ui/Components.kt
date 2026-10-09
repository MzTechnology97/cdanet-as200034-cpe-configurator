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
import it.cdanet.cpeconfigurator.tools.ToolResult

@Composable
fun SectionCard(title: String? = null, modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Card(
        modifier = modifier.fillMaxWidth().padding(vertical = 6.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (title != null) Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            content()
        }
    }
}

@Composable
fun Banner(text: String, color: Color, onDismiss: (() -> Unit)? = null) {
    Card(
        modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp),
        colors = CardDefaults.cardColors(containerColor = color.copy(alpha = 0.12f)),
    ) {
        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(text, color = color, modifier = Modifier.weight(1f))
            if (onDismiss != null) TextButton(onClick = onDismiss) { Text("OK") }
        }
    }
}

@Composable
fun ErrorBanner(text: String?, onDismiss: (() -> Unit)? = null) {
    if (!text.isNullOrBlank()) Banner(text, MaterialTheme.colorScheme.error, onDismiss)
}

@Composable
fun BusyButton(text: String, busy: Boolean, modifier: Modifier = Modifier, enabled: Boolean = true, primary: Boolean = true, onClick: () -> Unit) {
    val content: @Composable () -> Unit = {
        if (busy) {
            CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
            Spacer(Modifier.width(10.dp))
        }
        Text(text)
    }
    if (primary) {
        Button(onClick = onClick, enabled = enabled && !busy, modifier = modifier) { content() }
    } else {
        OutlinedButton(onClick = onClick, enabled = enabled && !busy, modifier = modifier) { content() }
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
                Text(display(selected), style = MaterialTheme.typography.bodyLarge)
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
