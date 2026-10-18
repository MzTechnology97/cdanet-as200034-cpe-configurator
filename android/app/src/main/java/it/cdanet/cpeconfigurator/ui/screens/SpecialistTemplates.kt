package it.cdanet.cpeconfigurator.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import it.cdanet.cpeconfigurator.R
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.data.CdaModelTemplatesDto
import it.cdanet.cpeconfigurator.data.CdaTemplateRefDto
import it.cdanet.cpeconfigurator.data.SpecFieldDto
import it.cdanet.cpeconfigurator.data.SpecFormStateDto
import it.cdanet.cpeconfigurator.data.SpecOptionDto
import it.cdanet.cpeconfigurator.data.SpecTemplateDto
import it.cdanet.cpeconfigurator.data.SpecTemplateFormDto
import it.cdanet.cpeconfigurator.data.cdaTemplates
import it.cdanet.cpeconfigurator.data.specAutoTemplate
import it.cdanet.cpeconfigurator.data.specCopyTemplate
import it.cdanet.cpeconfigurator.data.specCreateTemplate
import it.cdanet.cpeconfigurator.data.specDeleteTemplate
import it.cdanet.cpeconfigurator.data.specFormApply
import it.cdanet.cpeconfigurator.data.specFormRead
import it.cdanet.cpeconfigurator.data.specTemplate
import it.cdanet.cpeconfigurator.data.specTemplateForm
import it.cdanet.cpeconfigurator.data.specTemplates
import it.cdanet.cpeconfigurator.data.specUpdateTemplate
import it.cdanet.cpeconfigurator.specialist.SpecEditorOpen
import it.cdanet.cpeconfigurator.ui.BusyButton
import it.cdanet.cpeconfigurator.ui.Dropdown
import it.cdanet.cpeconfigurator.ui.EmptyState
import it.cdanet.cpeconfigurator.ui.ErrorBanner
import it.cdanet.cpeconfigurator.ui.Field
import it.cdanet.cpeconfigurator.ui.ListHeader
import it.cdanet.cpeconfigurator.ui.Notice
import it.cdanet.cpeconfigurator.ui.NoticeKind
import it.cdanet.cpeconfigurator.ui.PrimaryButton
import it.cdanet.cpeconfigurator.ui.SecondaryButton
import it.cdanet.cpeconfigurator.ui.SectionCard
import it.cdanet.cpeconfigurator.ui.Segmented
import it.cdanet.cpeconfigurator.ui.SkeletonRows
import it.cdanet.cpeconfigurator.ui.StatusChip
import it.cdanet.cpeconfigurator.ui.localTime
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

/*
 * «I miei template» in the app (owner, 17/10/2026): the specialist's airOS templates, apart from
 * CDA Net's (which stay as they are). The same form as the console's, like the CPE's own web
 * interface (the server reads and writes the text: nothing is stored until «Salva»); a template
 * can start from the form, from the CPE on the phone's Wi-Fi or from a copy of a CDA Net one.
 */

private val TEMPLATE_ERRORS = mapOf(
    "template_size" to "dimensione non valida (minimo 64 caratteri)",
    "profile_not_system_cfg" to "non sembra una configurazione airOS (mancano radio./wireless./netconf./users.)",
    "profile_contains_nul" to "contiene byte NUL",
    "invalid_placeholders" to "segnaposto non validi: \${NOME} con lettere maiuscole, cifre e _ (inizia con una lettera)",
    "too_many_placeholders" to "troppi segnaposto (al massimo 40)",
    "users_password_requires_hash_placeholder" to "users.N.password deve usare \${CPE_PASSWORD_HASH}, non \${CPE_PASSWORD}",
    "non_key_value_lines" to "alcune righe non sono nel formato chiave=valore",
)

private fun templateError(code: String) = TEMPLATE_ERRORS[code] ?: code

/** How each placeholder CDA Net knows is filled in the flow. */
private val FILLED_FROM = mapOf(
    "typed" to "scritto nel flusso per ogni CPE",
    "mac" to "dalla CPE letta (MAC)",
    "serial" to "dalla CPE letta (seriale)",
    "cpe" to "dalle credenziali scritte nel flusso",
    "template" to "dalla community del template, o scritta nel flusso",
    "connector" to "dal connettore UISP dell'azienda, o scritta nel flusso",
    "name" to "dal nome della CPE",
)

private val SECTIONS = listOf("wireless" to "Wireless", "network" to "Rete", "services" to "Servizi", "system" to "Sistema", "values" to "Valori", "advanced" to "Avanzate")

/** The list of his templates, by model, and the way to a new one. */
@Composable
fun SpecialistTemplateList(c: AppContainer, onEdit: () -> Unit) {
    val scope = rememberCoroutineScope()
    var list by remember { mutableStateOf<List<SpecTemplateDto>?>(null) }
    var meta by remember { mutableStateOf<SpecTemplateFormDto?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var creating by remember { mutableStateOf(false) }
    var opening by remember { mutableStateOf<Int?>(null) }
    val refresh = c.refresh.collectAsState().value
    suspend fun load() {
        busy = true
        runCatching { c.api.specTemplates() }
            .onSuccess {
                list = it
                error = null
            }
            .onFailure { error = it.message }
        if (meta == null) meta = runCatching { c.api.specTemplateForm() }.getOrNull()
        busy = false
    }
    LaunchedEffect(refresh) { load() }
    Column(verticalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.padding(bottom = 16.dp)) {
        Text(
            "I template airOS delle aziende per cui lavori, tuoi e separati da quelli di CDA Net (che restano come sono). Li crei e modifichi qui o nella console web.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        PrimaryButton(onClick = { creating = true }, modifier = Modifier.fillMaxWidth(), enabled = meta != null) { Text("Nuovo template") }
        ErrorBanner(error) { error = null }
        val items = list
        ListHeader(if (items == null) "I miei template" else if (items.isEmpty()) "Nessun template" else "${items.size} template", busy) { scope.launch { load() } }
        if (items == null && busy) SkeletonRows(3)
        if (items != null && items.isEmpty()) {
            EmptyState(R.drawable.ic_memory, "Nessun template", "Crea il primo: dal modulo (come l'interfaccia della CPE), dalla CPE collegata o partendo da un template CDA Net.")
        }
        items.orEmpty().groupBy { it.model }.forEach { (model, group) ->
            Text(model.uppercase(), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp, start = 4.dp))
            group.forEach { t ->
                Column(
                    Modifier
                        .fillMaxWidth()
                        .clip(MaterialTheme.shapes.large)
                        .background(MaterialTheme.colorScheme.surfaceContainerLow)
                        .clickable(enabled = opening == null) {
                            opening = t.id
                            scope.launch {
                                runCatching { c.api.specTemplate(t.id) }
                                    .onSuccess { full ->
                                        c.specialist.openEditor(
                                            SpecEditorOpen(
                                                model = full.model,
                                                id = full.id,
                                                name = full.name,
                                                notes = full.notes,
                                                template = full.template,
                                                boardMatch = full.boardMatch,
                                                snmpSet = full.secretsSet.snmpCommunity,
                                                author = full.author.takeIf { !full.mine },
                                                sha256 = full.sha256,
                                                updatedAt = full.updatedAt,
                                            ),
                                        )
                                        onEdit()
                                    }
                                    .onFailure { error = it.message }
                                opening = null
                            }
                        }
                        .padding(14.dp),
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(t.name, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                        // a template of another member of the group (issue #275)
                        if (!t.mine) StatusChip("di ${t.author}", NoticeKind.Info)
                        if (t.own.isNotEmpty()) StatusChip("${t.own.size} tuoi", NoticeKind.Info)
                    }
                    Text(
                        "${t.facts.mode} · LAN ${t.facts.lanIp ?: "—"} · ${t.jobs} ${if (t.jobs == 1) "installazione" else "installazioni"} · ${localTime(t.updatedAt)}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    if (t.notes.isNotBlank()) Text(t.notes, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
    val m = meta
    if (creating && m != null) {
        NewTemplateDialog(c, m, onDismiss = { creating = false }) { open ->
            creating = false
            c.specialist.openEditor(open)
            onEdit()
        }
    }
}

/** Where a new template starts from: the form alone, the CPE on the phone's Wi-Fi, a copy of a CDA Net template. */
@Composable
private fun NewTemplateDialog(c: AppContainer, meta: SpecTemplateFormDto, onDismiss: () -> Unit, onStart: (SpecEditorOpen) -> Unit) {
    val scope = rememberCoroutineScope()
    val cpeModel = c.specialist.state.collectAsState().value.cpe?.model
    var model by remember { mutableStateOf(cpeModel?.takeIf { it in meta.models } ?: meta.models.firstOrNull().orEmpty()) }
    var from by remember { mutableStateOf("form") }
    var name by remember { mutableStateOf("") }
    var user by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var cda by remember { mutableStateOf<List<CdaModelTemplatesDto>?>(null) }
    var cdaPick by remember { mutableStateOf<CdaTemplateRefDto?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(from) {
        if (from == "cda" && cda == null) {
            runCatching { c.api.cdaTemplates() }.onSuccess { cda = it }.onFailure { error = it.message }
        }
    }
    val cdaOfModel = cda?.firstOrNull { it.model == model }?.templates.orEmpty()
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text("Nuovo template") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Dropdown("Modello della CPE", meta.models, model, { it }, { model = it; cdaPick = null }, Modifier.fillMaxWidth())
                // CDA Net's templates: CDA Net's work, only with «visibilità piena» (issue #275)
                Segmented(listOfNotNull("form" to "Modulo", "cpe" to "Dalla CPE", ("cda" to "CDA Net").takeIf { c.session.seesAll }), from, { from = it })
                when (from) {
                    "form" -> Text("Una configurazione airOS completa (Station, Router, PPPoE): la modifichi dal modulo come l'interfaccia della CPE.", style = MaterialTheme.typography.bodySmall)
                    "cpe" -> {
                        Text(
                            "La configurazione della CPE collegata alla Wi-Fi del telefono: SSID, chiave Wi-Fi, PPPoE, credenziali, community SNMP, nome e chiave UISP diventano segnaposto, il resto resta com'è.",
                            style = MaterialTheme.typography.bodySmall,
                        )
                        Field("Utente della CPE (se non è di fabbrica)", user, { user = it.take(64) })
                        Field("Password della CPE", password, { password = it.take(200) }, password = true, supporting = "Solo per leggerla ora: mai salvata")
                    }
                    else -> when {
                        cda == null -> Text("Lettura dei template CDA Net…", style = MaterialTheme.typography.bodySmall)
                        cdaOfModel.isEmpty() -> Text("Nessun template CDA Net per $model.", style = MaterialTheme.typography.bodySmall)
                        else -> {
                            val none = CdaTemplateRefDto(id = 0, name = "Scegli…")
                            Dropdown("Template CDA Net", listOf(none) + cdaOfModel, cdaPick ?: none, { it.name }, { cdaPick = it.takeIf { t -> t.id != 0 } }, Modifier.fillMaxWidth())
                            Text("Ne fai una copia tua: quello di CDA Net resta com'è. La community SNMP e la chiave UISP di CDA Net non vengono copiate.", style = MaterialTheme.typography.bodySmall)
                        }
                    }
                }
                Field("Nome", name, { name = it.take(60) }, placeholder = "es. Wireless Sud · Station", supporting = "Unico per modello")
                error?.let { Notice(it, NoticeKind.Bad) }
            }
        },
        confirmButton = {
            TextButton(enabled = !busy && model.isNotBlank(), onClick = {
                scope.launch {
                    busy = true
                    error = null
                    try {
                        when (from) {
                            "form" -> onStart(SpecEditorOpen(model = model, name = name.trim()))
                            "cpe" -> {
                                val text = c.specialist.runningConfig(user, password)
                                val r = c.api.specAutoTemplate(model, text)
                                onStart(
                                    SpecEditorOpen(
                                        model = model,
                                        name = name.trim(),
                                        template = r.template,
                                        boardMatch = r.suggestedBoardMatch,
                                        replacements = r.replacements,
                                        warnings = r.warnings,
                                    ),
                                )
                            }
                            else -> {
                                val pick = cdaPick ?: throw IllegalStateException("Scegli il template CDA Net da cui partire")
                                if (name.isBlank()) throw IllegalStateException("Scrivi il nome del tuo template")
                                val t = c.api.specCopyTemplate(pick.id, name.trim())
                                val full = c.api.specTemplate(t.id)
                                c.specialist.templatesChanged()
                                onStart(
                                    SpecEditorOpen(
                                        model = full.model,
                                        id = full.id,
                                        name = full.name,
                                        notes = full.notes,
                                        template = full.template,
                                        boardMatch = full.boardMatch,
                                        sha256 = full.sha256,
                                        updatedAt = full.updatedAt,
                                    ),
                                )
                            }
                        }
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        error = e.message ?: e.toString()
                    } finally {
                        busy = false
                    }
                }
            }) { Text(if (busy) "Attendi…" else if (from == "cda") "Crea la copia" else "Continua") }
        },
        dismissButton = { TextButton(enabled = !busy, onClick = onDismiss) { Text("Annulla") } },
    )
}

/**
 * The editor of one template (a screen of its own): the form like the CPE's web interface, the
 * values, the text. [onUse]: to «Nuova CPE» with this template chosen, the configuration first.
 */
@Composable
fun SpecialistTemplateEditor(c: AppContainer, onClose: () -> Unit, onUse: () -> Unit = onClose) {
    val open = c.specialist.editing.collectAsState().value
    if (open == null) {
        EmptyState(R.drawable.ic_memory, "Nessun template aperto", "Torna all'elenco dei template.")
        return
    }
    key(open) { TemplateEditorBody(c, open, onClose, onUse) }
}

@Composable
private fun TemplateEditorBody(c: AppContainer, open: SpecEditorOpen, onClose: () -> Unit, onUse: () -> Unit) {
    val scope = rememberCoroutineScope()
    var meta by remember { mutableStateOf<SpecTemplateFormDto?>(null) }
    var form by remember { mutableStateOf<SpecFormStateDto?>(null) }
    var pending by remember { mutableStateOf<Map<String, JsonPrimitive>>(emptyMap()) }
    var name by remember { mutableStateOf(open.name) }
    var notes by remember { mutableStateOf(open.notes) }
    var boardMatch by remember { mutableStateOf(open.boardMatch.orEmpty()) }
    var snmp by remember { mutableStateOf("") }
    var snmpSet by remember { mutableStateOf(open.snmpSet) }
    var removeSnmp by remember { mutableStateOf(false) }
    var section by remember { mutableStateOf("wireless") }
    var text by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var saved by remember { mutableStateOf<String?>(null) }
    var savedId by remember { mutableStateOf(open.id) }
    var dirty by remember { mutableStateOf(open.template != null && open.id == null) }
    var askClose by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }

    /** One step at a time: [what] is busy meanwhile, a failure becomes the error shown. */
    suspend fun step(what: String, block: suspend () -> Unit) {
        busy = what
        error = null
        try {
            block()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e.message ?: e.toString()
        } finally {
            busy = null
        }
    }

    /** The changes typed written into the text by the server (only what changed). */
    suspend fun flush(): SpecFormStateDto? {
        val cur = form ?: return null
        val changes = pending
        if (changes.isEmpty()) return cur
        val r = c.api.specFormApply(open.model, cur.template, changes)
        pending = emptyMap()
        form = r
        return r
    }

    /** The text edited by hand read again into the form. */
    suspend fun reread(t: String): SpecFormStateDto {
        val r = c.api.specFormRead(open.model, t)
        form = r
        pending = emptyMap()
        return r
    }

    suspend fun goTo(next: String) {
        val cur = form
        val t = text
        if (section == "advanced" && t != null && cur != null && t != cur.template) reread(t) else flush()
        if (next == "advanced") text = form?.template
        section = next
    }

    suspend fun save() {
        if (name.isBlank()) throw IllegalStateException("Scrivi il nome del template")
        val t = text
        val last = form
        val cur = (if (section == "advanced" && t != null && last != null && t != last.template) reread(t) else flush())
            ?: throw IllegalStateException("Configurazione non ancora caricata")
        if (!cur.report.ok) {
            section = "advanced"
            text = cur.template
            throw IllegalStateException("Configurazione non valida: " + cur.report.errors.joinToString("; ") { templateError(it) })
        }
        val id = savedId
        val r = if (id == null) {
            c.api.specCreateTemplate(open.model, name.trim(), cur.template, boardMatch.trim(), notes.trim(), snmp.ifEmpty { null })
        } else {
            c.api.specUpdateTemplate(id, name.trim(), cur.template, boardMatch.trim(), notes.trim(), snmp.ifEmpty { null }, removeSnmp)
        }
        savedId = r.id
        snmpSet = r.secretsSet.snmpCommunity
        snmp = ""
        removeSnmp = false
        dirty = false
        saved = "Template «${r.name}» salvato · ${r.sha256.take(12)}…"
        c.specialist.templatesChanged()
    }

    LaunchedEffect(Unit) {
        step("load") {
            val m = c.api.specTemplateForm()
            meta = m
            if (boardMatch.isBlank()) boardMatch = m.boardMatch[open.model].orEmpty()
            form = c.api.specFormRead(open.model, open.template)
        }
    }
    // the way back asks before throwing the changes away
    BackHandler(enabled = dirty) { askClose = true }

    val fs = form
    val m = meta
    Column(verticalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.padding(bottom = 24.dp)) {
        SectionCard(if (savedId == null) "Nuovo template · ${open.model}" else "Template · ${open.model}", icon = R.drawable.ic_memory) {
            // a template of a colleague of the group (Carmelo, 18/10/2026): only its author changes it
            open.author?.let { a ->
                Notice("Template di $a, del tuo gruppo di lavoro: lo usi nel flusso con i tuoi valori e i tuoi segreti; lo modifica e lo elimina solo $a.", NoticeKind.Info)
            }
            if (savedId != null && open.updatedAt.isNotBlank()) {
                Text("Ultima modifica ${localTime(open.updatedAt)} · SHA-256 ${open.sha256.take(16)}…", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Field("Nome", name, { name = it.take(60); dirty = true }, placeholder = "es. Wireless Sud · Station", supporting = "Unico per modello")
            Field("Board match (regex su /etc/board.info)", boardMatch, { boardMatch = it.take(240); dirty = true }, supporting = "L'app scrive solo su una CPE di questo modello")
            Field("Note", notes, { notes = it.take(500); dirty = true }, placeholder = "Per chi è, a cosa serve")
            if (open.replacements.isNotEmpty() || open.warnings.isNotEmpty()) {
                val names = open.replacements.map { it.placeholder }.distinct().joinToString(", ")
                Notice(
                    "Dalla CPE: ${open.replacements.size} valori diventati segnaposto ($names)." + if (open.warnings.isNotEmpty()) "\n" + open.warnings.joinToString("\n") else "",
                    NoticeKind.Info,
                )
            }
            if (fs != null) {
                Text(
                    "${fs.facts.mode} · LAN ${fs.facts.lanIp ?: "—"}" + if (fs.report.own.isNotEmpty()) " · ${fs.report.own.size} segnaposto tuoi" else "",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (!fs.report.ok) Notice("Configurazione non valida: " + fs.report.errors.joinToString("; ") { templateError(it) }, NoticeKind.Bad)
            }
        }
        if (fs == null || m == null) {
            if (error == null) SkeletonRows(4)
        } else {
            Segmented(SECTIONS, section, { next -> if (next != section) scope.launch { step("section") { goTo(next) } } }, fill = false)
            when (section) {
                "values" -> PlaceholdersCard(fs, m)
                "advanced" -> SectionCard("Testo del template (system.cfg)") {
                    OutlinedTextField(
                        value = text ?: fs.template,
                        onValueChange = {
                            text = it
                            dirty = true
                        },
                        modifier = Modifier.fillMaxWidth().heightIn(min = 240.dp, max = 520.dp),
                        textStyle = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                        label = { Text("system.cfg") },
                    )
                    Text("Il modulo rilegge il testo quando torni a una scheda o salvi.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    BusyButton("Rileggi il modulo dal testo", busy == "reread", Modifier.fillMaxWidth(), enabled = busy == null, primary = false) {
                        scope.launch { step("reread") { text?.let { t -> text = reread(t).template } } }
                    }
                    if (fs.report.ok && fs.report.warnings.isEmpty()) {
                        Text("Configurazione valida · ${fs.report.lines} righe.", style = MaterialTheme.typography.bodySmall)
                    }
                    if (fs.report.warnings.isNotEmpty()) Notice(fs.report.warnings.joinToString("\n") { templateError(it) }, NoticeKind.Warn)
                }
                else -> SectionCard(SECTIONS.firstOrNull { it.first == section }?.second ?: section) {
                    val value: (String) -> JsonPrimitive? = { id -> pending[id] ?: (fs.values[id] as? JsonPrimitive) }
                    val on: (String) -> Boolean = { id -> value(id)?.let { it.booleanOrNull ?: (it.content == "true") } == true }
                    m.fields.filter { it.section == section && shownField(it, value, on) }.forEach { fd ->
                        val v = value(fd.id)
                        val missing = fd.id in fs.missing && fd.id !in pending
                        val hint = listOfNotNull(
                            fd.hint.ifBlank { null },
                            if (missing) "Non presente nel template: scritto solo se lo cambi." else null,
                            if (fd.experimental) "Chiave da provare al banco." else null,
                        ).joinToString(" ")
                        when (fd.type) {
                            "bool" -> BoolRow(fd.label, hint, on(fd.id)) { checked ->
                                pending = pending + (fd.id to JsonPrimitive(checked))
                                dirty = true
                                scope.launch { step("apply") { flush() } }
                            }
                            "select" -> {
                                val current = fd.options.firstOrNull { it.value == v?.content } ?: SpecOptionDto(v?.content.orEmpty(), v?.content.orEmpty())
                                Dropdown(fd.label, fd.options, current, { it.label.ifBlank { it.value } }, { o ->
                                    pending = pending + (fd.id to JsonPrimitive(o.value))
                                    dirty = true
                                    scope.launch { step("apply") { flush() } }
                                }, Modifier.fillMaxWidth())
                                if (hint.isNotBlank()) Text(hint, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            else -> Field(
                                fd.label,
                                v?.content.orEmpty(),
                                { nv ->
                                    val typed = if (fd.type == "int") nv.trim().toIntOrNull()?.let { JsonPrimitive(it) } ?: JsonPrimitive(nv) else JsonPrimitive(nv)
                                    pending = pending + (fd.id to typed)
                                    dirty = true
                                },
                                keyboardType = when (fd.type) {
                                    "int" -> KeyboardType.Number
                                    "ip" -> KeyboardType.Decimal
                                    else -> KeyboardType.Text
                                },
                                supporting = hint.ifBlank { null },
                            )
                        }
                    }
                    if (section == "services") {
                        val uses = "SNMP_COMMUNITY" in fs.report.placeholders
                        Field(
                            "SNMP: community",
                            snmp,
                            {
                                snmp = it.take(200)
                                dirty = true
                            },
                            password = true,
                            readOnly = removeSnmp || open.author != null,
                            supporting = when {
                                // the secrets of a template are its author's (issue #275)
                                open.author != null -> "La imposta solo ${open.author}, che ha creato il template, e vale solo per le sue installazioni: nelle tue la scrivi nel flusso per ogni CPE."
                                snmpSet && !removeSnmp -> "Impostata: lascia vuoto per non cambiarla. Cifrata, mai mostrata. Vale solo per le tue installazioni."
                                uses -> "Facoltativa: senza, la scrivi nel flusso per ogni CPE. Cifrata, mai mostrata."
                                else -> "Il template non usa \${SNMP_COMMUNITY}."
                            },
                        )
                        if (snmpSet && open.author == null) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Switch(checked = removeSnmp, onCheckedChange = {
                                    removeSnmp = it
                                    if (it) snmp = ""
                                    dirty = true
                                })
                                Spacer(Modifier.width(10.dp))
                                Text("Rimuovi la community da questo template", style = MaterialTheme.typography.bodyMedium)
                            }
                        }
                    }
                    if (pending.isNotEmpty()) {
                        BusyButton("Applica le modifiche", busy == "apply", Modifier.fillMaxWidth(), enabled = busy == null, primary = false) {
                            scope.launch { step("apply") { flush() } }
                        }
                    }
                }
            }
        }
        ErrorBanner(error) { error = null }
        saved?.let { Notice(it, NoticeKind.Good) }
        if (open.author == null) {
            BusyButton("Salva template", busy == "save", Modifier.fillMaxWidth(), enabled = busy == null && fs != null) {
                scope.launch { step("save") { save() } }
            }
        }
        // saved: the configuration of a CPE with it, without the CPE's Wi-Fi (the CPE comes after)
        val usable = savedId
        if (usable != null && !dirty) {
            SecondaryButton(onClick = {
                c.specialist.updateForm { it.copy(templateId = usable) }
                onUse()
            }, modifier = Modifier.fillMaxWidth(), enabled = busy == null) { Text("Prepara una configurazione con questo template") }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            if (savedId != null && open.author == null) TextButton(onClick = { confirmDelete = true }, enabled = busy == null) { Text("Elimina template") }
            Spacer(Modifier.weight(1f))
            TextButton(onClick = { if (dirty) askClose = true else onClose() }) { Text("Chiudi") }
        }
    }
    if (askClose) {
        AlertDialog(
            onDismissRequest = { askClose = false },
            title = { Text("Uscire senza salvare?") },
            text = { Text("Le modifiche a questo template non sono ancora salvate.") },
            confirmButton = {
                TextButton(onClick = {
                    askClose = false
                    dirty = false
                    onClose()
                }) { Text("Esci") }
            },
            dismissButton = { TextButton(onClick = { askClose = false }) { Text("Resta") } },
        )
    }
    val deleteId = savedId
    if (confirmDelete && deleteId != null) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("Eliminare il template?") },
            text = { Text("«$name» (${open.model}): le installazioni fatte con questo template restano nello storico.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmDelete = false
                    scope.launch {
                        step("delete") {
                            c.api.specDeleteTemplate(deleteId)
                            c.specialist.templatesChanged()
                            dirty = false
                            onClose()
                        }
                    }
                }) { Text("Elimina") }
            },
            dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("Annulla") } },
        )
    }
}

/** Whether a field is shown, as in the console: the mode it belongs to, the options it depends on. */
private fun shownField(f: SpecFieldDto, value: (String) -> JsonPrimitive?, on: (String) -> Boolean): Boolean {
    val wireless = f.only?.wirelessMode
    val net = f.only?.netMode
    if (wireless != null && value("wirelessMode")?.content != wireless) return false
    if (net != null && value("netMode")?.content != net) return false
    if (f.id.startsWith("scan") && f.id != "scanLimit" && !on("scanLimit")) return false
    if (f.id == "ackDistance" && on("ackAuto")) return false
    if (f.id.startsWith("syslog") && f.id != "syslogRemote" && !on("syslogRemote")) return false
    if (f.id.startsWith("watchdog") && f.id != "watchdog" && value("watchdog")?.booleanOrNull == false) return false
    return true
}

@Composable
private fun BoolRow(label: String, hint: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(label, style = MaterialTheme.typography.bodyLarge)
            if (hint.isNotBlank()) Text(hint, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Spacer(Modifier.width(10.dp))
        Switch(checked = checked, onCheckedChange = onChange)
    }
}

/** «Valori»: every placeholder of the text and how the flow fills it. */
@Composable
private fun PlaceholdersCard(fs: SpecFormStateDto, meta: SpecTemplateFormDto) {
    SectionCard("Valori per ogni CPE") {
        Text(
            "Ogni segnaposto prende il suo valore al momento, per ogni CPE: la chiave Wi-Fi e le password si scrivono nel flusso e non vengono mai salvate. " +
                "Per aggiungerne uno tuo scrivi \${NOME} nel testo (Avanzate), per esempio vlan.1.id=\${VLAN_ID}.",
            style = MaterialTheme.typography.bodySmall,
        )
        val known = meta.placeholders.associateBy { it.name }
        if (fs.report.placeholders.isEmpty()) {
            Text("Nessun segnaposto: ogni CPE riceve lo stesso file.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        fs.report.placeholders.forEach { p ->
            val k = known[p]
            Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("\${$p}", style = MaterialTheme.typography.bodyMedium, fontFamily = FontFamily.Monospace)
                    Text(
                        (k?.label ?: "Tuo") + " · " + (FILLED_FROM[k?.from ?: "typed"] ?: "scritto nel flusso per ogni CPE"),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (k?.secret == true) StatusChip("segreto", NoticeKind.Warn)
            }
        }
    }
}
