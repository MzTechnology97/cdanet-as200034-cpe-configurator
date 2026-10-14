package it.cdanet.cpeconfigurator.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.data.CalendarDto
import it.cdanet.cpeconfigurator.data.WorkOrderDto
import it.cdanet.cpeconfigurator.ui.Dropdown
import it.cdanet.cpeconfigurator.ui.ErrorBanner
import it.cdanet.cpeconfigurator.ui.NoticeKind
import it.cdanet.cpeconfigurator.ui.PrimaryButton
import it.cdanet.cpeconfigurator.ui.SecondaryButton
import it.cdanet.cpeconfigurator.ui.Segmented
import it.cdanet.cpeconfigurator.ui.StatusChip
import it.cdanet.cpeconfigurator.ui.Tone
import it.cdanet.cpeconfigurator.ui.cardBorder
import it.cdanet.cpeconfigurator.ui.colors
import java.time.DayOfWeek
import java.time.LocalDate
import java.time.YearMonth
import java.time.format.DateTimeFormatter
import java.time.temporal.TemporalAdjusters
import java.util.Locale

enum class CalView { Day, Week, Month }

/** Dates and time slots of the calendar (pure, tested). */
object CalendarMath {
    private val SLOT = Regex("""^\s*(\d{1,2})[:.](\d{2})\s*(?:[-–]\s*(\d{1,2})[:.](\d{2}))?""")
    private val IT = Locale.ITALIAN

    /** "09:00-11:00" → minutes from midnight (start, end); a single time lasts an hour; null = no time set. */
    fun slotMinutes(slot: String): Pair<Int, Int>? {
        val m = SLOT.find(slot) ?: return null
        val h = m.groupValues[1].toInt()
        val min = m.groupValues[2].toInt()
        if (h > 23 || min > 59) return null
        val start = h * 60 + min
        val end = if (m.groupValues[3].isNotEmpty()) m.groupValues[3].toInt() * 60 + m.groupValues[4].toInt() else start + 60
        return start to (if (end > start) end.coerceAtMost(24 * 60) else start + 60)
    }

    fun weekStart(d: LocalDate): LocalDate = d.with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY))

    /** The 6 weeks shown for a month, from the Monday before its first day. */
    fun monthGrid(month: YearMonth): List<LocalDate> {
        val start = weekStart(month.atDay(1))
        return (0L until 42L).map { start.plusDays(it) }
    }

    /** The days to load for a view around [d] (at most 42: within the server's 62). */
    fun range(view: CalView, d: LocalDate): Pair<LocalDate, LocalDate> = when (view) {
        CalView.Day -> d to d
        CalView.Week -> weekStart(d) to weekStart(d).plusDays(6)
        CalView.Month -> monthGrid(YearMonth.from(d)).let { it.first() to it.last() }
    }

    /** The same view one step before (-1) or after (+1). */
    fun shift(view: CalView, d: LocalDate, step: Long): LocalDate = when (view) {
        CalView.Day -> d.plusDays(step)
        CalView.Week -> d.plusWeeks(step)
        CalView.Month -> d.plusMonths(step).withDayOfMonth(1)
    }

    fun title(view: CalView, d: LocalDate): String = when (view) {
        CalView.Day -> d.format(DateTimeFormatter.ofPattern("EEEE d MMMM yyyy", IT)).replaceFirstChar { it.uppercase() }
        CalView.Week -> {
            val a = weekStart(d)
            val b = a.plusDays(6)
            if (a.month == b.month) "${a.dayOfMonth} – ${b.format(DateTimeFormatter.ofPattern("d MMMM yyyy", IT))}"
            else "${a.format(DateTimeFormatter.ofPattern("d MMM", IT))} – ${b.format(DateTimeFormatter.ofPattern("d MMM yyyy", IT))}"
        }
        CalView.Month -> d.format(DateTimeFormatter.ofPattern("MMMM yyyy", IT)).replaceFirstChar { it.uppercase() }
    }

    /**
     * Side-by-side columns for the orders of one day that overlap in time: lane of each order (by
     * index) and how many lanes the day needs.
     */
    fun lanes(slots: List<Pair<Int, Int>>): Pair<List<Int>, Int> {
        val order = slots.indices.sortedBy { slots[it].first }
        val ends = mutableListOf<Int>()
        val lane = IntArray(slots.size)
        for (i in order) {
            val free = ends.indexOfFirst { it <= slots[i].first }
            if (free >= 0) {
                lane[i] = free
                ends[free] = slots[i].second
            } else {
                lane[i] = ends.size
                ends += slots[i].second
            }
        }
        return lane.toList() to ends.size.coerceAtLeast(1)
    }
}

private fun kindTone(kind: String) = when (kind) {
    "new" -> Tone.Brand
    "repoint" -> Tone.Info
    "repair" -> Tone.Warn
    "survey" -> Tone.Good
    else -> Tone.Neutral
}

private fun statusLabel(o: WorkOrderDto): Pair<String, NoticeKind>? = when {
    o.status == "done" -> "fatto" to NoticeKind.Good
    o.overdue -> "in ritardo" to NoticeKind.Bad
    o.status == "started" -> "in corso" to NoticeKind.Warn
    o.status == "postponed" -> "rimandato" to NoticeKind.Warn
    else -> null
}

/**
 * Calendario degli interventi, as in Google Calendar: day, week and month. An installer sees their
 * own orders; an admin (NOC) everyone's, or one installer's. A tap on an order opens its details,
 * with «Inizia» on the day it is due.
 */
@Composable
fun CalendarScreen(c: AppContainer, onOpen: (Dest) -> Unit) {
    var view by remember { mutableStateOf(CalView.Week) }
    var anchor by remember { mutableStateOf(LocalDate.now()) }
    var user by remember { mutableStateOf<Long?>(null) }
    var data by remember { mutableStateOf<CalendarDto?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var open by remember { mutableStateOf<WorkOrderDto?>(null) }
    val refresh by c.refresh.collectAsState()
    val (from, to) = CalendarMath.range(view, anchor)
    LaunchedEffect(from, to, user, refresh) {
        runCatching { c.api.workOrderCalendar(from.toString(), to.toString(), user) }
            .onSuccess { data = it; error = null }
            .onFailure { error = "Calendario non aggiornato: ${it.message ?: "nessuna rete"}" }
    }
    val items = data?.takeIf { it.from <= from.toString() && it.to >= to.toString() }?.items.orEmpty()
    val today = data?.today?.takeIf { it.isNotBlank() }?.let { LocalDate.parse(it) } ?: LocalDate.now()

    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Segmented(listOf(CalView.Day to "Giorno", CalView.Week to "Settimana", CalView.Month to "Mese"), view, { view = it })
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = { anchor = CalendarMath.shift(view, anchor, -1) }) { Text("‹", style = MaterialTheme.typography.headlineSmall) }
            Text(CalendarMath.title(view, anchor), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            TextButton(onClick = { anchor = CalendarMath.shift(view, anchor, 1) }) { Text("›", style = MaterialTheme.typography.headlineSmall) }
            SecondaryButton(onClick = { anchor = today }) { Text("Oggi") }
        }
        data?.installers?.let { list ->
            val all = listOf<Pair<Long?, String>>(null to "Tutti gli installatori") + list.map { it.id to it.username }
            Dropdown("Installatore", all, all.firstOrNull { it.first == user } ?: all.first(), { it.second }, { user = it.first }, Modifier.fillMaxWidth())
        }
        ErrorBanner(error) { error = null }
        when (view) {
            CalView.Day -> {
                Untimed(items.filter { it.day == anchor.toString() }) { open = it }
                Timeline(listOf(anchor), items, today, showAssignee = data?.installers != null) { open = it }
            }
            CalView.Week -> {
                val days = (0L until 7L).map { CalendarMath.weekStart(anchor).plusDays(it) }
                WeekHeader(days, today) { d -> anchor = d; view = CalView.Day }
                Untimed(items.filter { o -> days.any { it.toString() == o.day } }, withDay = true) { open = it }
                Timeline(days, items, today, showAssignee = false) { open = it }
            }
            CalView.Month -> {
                MonthGrid(YearMonth.from(anchor), anchor, today, items) { d -> anchor = d }
                Text(CalendarMath.title(CalView.Day, anchor), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                val day = items.filter { it.day == anchor.toString() }
                if (day.isEmpty()) Text("Nessun intervento.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                day.forEach { o -> AgendaRow(o, showAssignee = data?.installers != null) { open = o } }
            }
        }
        Text(
            "Colori: arancio nuova installazione, blu ripuntamento, giallo riparazione, verde sopralluogo. Gli interventi fatti sono sbiaditi.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
    open?.let { o -> OrderDialog(c, o, today, onOpen) { open = null } }
}

@Composable
private fun WeekHeader(days: List<LocalDate>, today: LocalDate, onDay: (LocalDate) -> Unit) {
    Row(Modifier.fillMaxWidth().padding(start = AXIS)) {
        days.forEach { d ->
            Column(Modifier.weight(1f).clickable { onDay(d) }, horizontalAlignment = Alignment.CenterHorizontally) {
                Text(d.format(DateTimeFormatter.ofPattern("EEE", Locale.ITALIAN)).take(3), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                DayNumber(d.dayOfMonth, d == today, selected = false)
            }
        }
    }
}

@Composable
private fun DayNumber(n: Int, today: Boolean, selected: Boolean) {
    val brand = Tone.Brand.colors
    Box(
        Modifier.size(28.dp).clip(CircleShape).background(
            when {
                today -> brand.content
                selected -> brand.container
                else -> androidx.compose.ui.graphics.Color.Transparent
            },
        ),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            "$n",
            style = MaterialTheme.typography.labelLarge,
            fontWeight = if (today || selected) FontWeight.Bold else FontWeight.Normal,
            color = if (today) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface,
        )
    }
}

/** Orders without a time: a row of chips above the hours. */
@Composable
private fun Untimed(list: List<WorkOrderDto>, withDay: Boolean = false, onTap: (WorkOrderDto) -> Unit) {
    val untimed = list.filter { CalendarMath.slotMinutes(it.slot) == null }
    if (untimed.isEmpty()) return
    Text("Senza orario", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    untimed.forEach { o ->
        val t = kindTone(o.kind).colors
        Row(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(t.container).clickable { onTap(o) }.padding(horizontal = 10.dp, vertical = 6.dp)
                .alpha(if (o.status == "done") 0.55f else 1f),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                (if (withDay) LocalDate.parse(o.day).format(DateTimeFormatter.ofPattern("EEE d", Locale.ITALIAN)) + " · " else "") + o.customer,
                color = t.content,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            statusLabel(o)?.let { (s, k) -> StatusChip(s, k) }
        }
    }
}

private val AXIS = 40.dp
private val HOUR = 56.dp

/** Hours down the side, one column per day, each order a block from its start to its end. */
@Composable
private fun Timeline(days: List<LocalDate>, items: List<WorkOrderDto>, today: LocalDate, showAssignee: Boolean, onTap: (WorkOrderDto) -> Unit) {
    val timed = items.mapNotNull { o -> CalendarMath.slotMinutes(o.slot)?.let { o to it } }.filter { (o, _) -> days.any { it.toString() == o.day } }
    val first = (timed.minOfOrNull { it.second.first / 60 } ?: 8).coerceAtMost(7)
    val last = (timed.maxOfOrNull { (it.second.second + 59) / 60 } ?: 19).coerceAtLeast(20)
    val hours = last - first
    val line = MaterialTheme.colorScheme.outlineVariant
    val now = java.time.LocalTime.now()
    Row(Modifier.fillMaxWidth().height(HOUR * hours).border(cardBorder().width, line, RoundedCornerShape(8.dp)).clip(RoundedCornerShape(8.dp))) {
        Box(Modifier.width(AXIS).height(HOUR * hours)) {
            for (h in first until last) {
                Text("%02d".format(h), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.offset(y = HOUR * (h - first) + 2.dp).padding(start = 8.dp))
            }
        }
        days.forEach { d ->
            BoxWithConstraints(Modifier.weight(1f).height(HOUR * hours).background(if (d == today && days.size > 1) Tone.Brand.colors.container.copy(alpha = 0.25f) else androidx.compose.ui.graphics.Color.Transparent)) {
                for (h in 1 until hours) HorizontalDivider(Modifier.offset(y = HOUR * h), color = line.copy(alpha = 0.5f))
                // where the day is now: a line across today's column
                if (d == today && now.hour in first until last) {
                    HorizontalDivider(Modifier.offset(y = HOUR * (now.hour - first) + HOUR * now.minute / 60f), thickness = 2.dp, color = Tone.Bad.colors.content)
                }
                val day = timed.filter { it.first.day == d.toString() }
                val (lane, lanes) = CalendarMath.lanes(day.map { it.second })
                val laneWidth: Dp = maxWidth / lanes
                day.forEachIndexed { i, (o, slot) ->
                    val t = kindTone(o.kind).colors
                    val top = HOUR * ((slot.first - first * 60) / 60f)
                    val height = (HOUR * ((slot.second - slot.first) / 60f)).coerceAtLeast(26.dp)
                    Column(
                        Modifier.offset(x = laneWidth * lane[i], y = top).width(laneWidth).height(height).padding(1.dp)
                            .clip(RoundedCornerShape(6.dp)).background(t.container)
                            .border(if (o.overdue) 2.dp else 0.dp, if (o.overdue) Tone.Bad.colors.content else t.container, RoundedCornerShape(6.dp))
                            .clickable { onTap(o) }.padding(horizontal = 4.dp, vertical = 2.dp).alpha(if (o.status == "done") 0.55f else 1f),
                    ) {
                        // too narrow for words (week, orders side by side): the coloured block alone, a tap shows it
                        if (days.size == 1 || laneWidth >= 34.dp) {
                            Text(o.customer, color = t.content, fontWeight = FontWeight.SemiBold, fontSize = if (days.size > 1) 10.sp else 13.sp, maxLines = if (days.size > 1) 3 else 1, overflow = TextOverflow.Ellipsis, lineHeight = if (days.size > 1) 11.sp else 16.sp)
                        }
                        if (days.size == 1) {
                            Text(listOfNotNull(o.slot, o.kindLabel, if (showAssignee) o.assignee else null).joinToString(" · "), color = t.content, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            // a one-hour block holds two lines: the address only in longer ones (a tap shows it)
                            if (o.address.isNotBlank() && height > HOUR) Text(o.address, color = t.content, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
        }
    }
}

/** Six weeks; every day with a coloured dot per order (up to three, then +n). */
@Composable
private fun MonthGrid(month: YearMonth, selected: LocalDate, today: LocalDate, items: List<WorkOrderDto>, onDay: (LocalDate) -> Unit) {
    val byDay = items.groupBy { it.day }
    Column(Modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth()) {
            listOf("lun", "mar", "mer", "gio", "ven", "sab", "dom").forEach {
                Text(it, Modifier.weight(1f), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
            }
        }
        CalendarMath.monthGrid(month).chunked(7).forEach { week ->
            Row(Modifier.fillMaxWidth()) {
                week.forEach { d ->
                    val list = byDay[d.toString()].orEmpty()
                    Column(
                        Modifier.weight(1f).aspectRatio(0.9f).clip(RoundedCornerShape(8.dp)).clickable { onDay(d) }
                            .alpha(if (d.month == month.month) 1f else 0.4f).padding(2.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        DayNumber(d.dayOfMonth, d == today, selected = d == selected)
                        Spacer(Modifier.height(2.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                            list.take(3).forEach { o -> Box(Modifier.size(6.dp).clip(CircleShape).background(kindTone(o.kind).colors.content).alpha(if (o.status == "done") 0.5f else 1f)) }
                        }
                        if (list.size > 3) Text("+${list.size - 3}", fontSize = 9.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
    }
}

@Composable
private fun AgendaRow(o: WorkOrderDto, showAssignee: Boolean, onTap: () -> Unit) {
    val t = kindTone(o.kind).colors
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).border(cardBorder().width, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(10.dp))
            .clickable(onClick = onTap).padding(10.dp).alpha(if (o.status == "done") 0.6f else 1f),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.width(4.dp).height(40.dp).clip(RoundedCornerShape(2.dp)).background(t.content))
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(o.customer, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(listOfNotNull(o.slot.ifBlank { "senza orario" }, o.kindLabel, if (showAssignee) o.assignee else null).joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = t.content)
        }
        statusLabel(o)?.let { (s, k) -> StatusChip(s, k) }
    }
}

@Composable
private fun OrderDialog(c: AppContainer, o: WorkOrderDto, today: LocalDate, onOpen: (Dest) -> Unit, onClose: () -> Unit) {
    val context = LocalContext.current
    val me = c.session.state.collectAsState().value?.user?.id
    // «Inizia» on the order's day (or late), for the installer it is assigned to, until it is done
    val canStart = o.status != "done" && o.status != "cancelled" && LocalDate.parse(o.day) <= today && (o.assignedTo == null || o.assignedTo == me?.toLong())
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text(o.customer) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    LocalDate.parse(o.day).format(DateTimeFormatter.ofPattern("EEEE d MMMM", Locale.ITALIAN)).replaceFirstChar { it.uppercase() } +
                        (if (o.slot.isNotBlank()) " · ${o.slot}" else ""),
                    fontWeight = FontWeight.SemiBold,
                )
                Text(o.kindLabel.ifBlank { o.kind }, color = kindTone(o.kind).colors.content)
                // whose it is, when it is not the viewer's own (the NOC's calendar)
                o.assignee?.takeIf { o.assignedTo != me?.toLong() }?.let { Text("Installatore: $it", style = MaterialTheme.typography.bodySmall) }
                if (o.address.isNotBlank()) Text(o.address)
                if (o.contact.isNotBlank()) Text("Contatto: ${o.contact}", style = MaterialTheme.typography.bodySmall)
                if (o.model.isNotBlank()) Text("CPE: ${o.model}", style = MaterialTheme.typography.bodySmall)
                if (o.notes.isNotBlank()) Text(o.notes, style = MaterialTheme.typography.bodySmall)
                if (o.statusNote.isNotBlank()) Text("Nota: ${o.statusNote}", style = MaterialTheme.typography.bodySmall)
                statusLabel(o)?.let { (s, k) -> StatusChip(s, k) }
                if (o.id in c.provisioning.field.ready.collectAsState().value) StatusChip("pronto offline", NoticeKind.Good)
            }
        },
        confirmButton = {
            if (canStart) PrimaryButton(onClick = { onClose(); startOrder(c, o, onOpen) }) { Text("Inizia") }
            else TextButton(onClick = onClose) { Text("Chiudi") }
        },
        dismissButton = {
            Row {
                if (o.address.isNotBlank() || o.lat != null) TextButton(onClick = { navigateTo(context, o) }) { Text("Naviga") }
                if (canStart) TextButton(onClick = onClose) { Text("Chiudi") }
            }
        },
    )
}
