package it.cdanet.cpeconfigurator.ui.screens

import android.annotation.SuppressLint
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import it.cdanet.cpeconfigurator.core.AppContainer
import it.cdanet.cpeconfigurator.install.RouterCheck
import it.cdanet.cpeconfigurator.network.NetworkHelper.CpeWifi
import it.cdanet.cpeconfigurator.tools.speedtest.RouterWifi
import it.cdanet.cpeconfigurator.tools.speedtest.SpeedProgress
import it.cdanet.cpeconfigurator.tools.speedtest.SpeedResult
import it.cdanet.cpeconfigurator.tools.speedtest.SpeedTarget
import it.cdanet.cpeconfigurator.tools.speedtest.SpeedtestConfig
import it.cdanet.cpeconfigurator.tools.speedtest.SpeedtestMath
import it.cdanet.cpeconfigurator.tools.speedtest.SpeedtestSubject
import it.cdanet.cpeconfigurator.tools.wifi.WifiAp
import it.cdanet.cpeconfigurator.ui.Banner
import it.cdanet.cpeconfigurator.ui.BusyButton
import it.cdanet.cpeconfigurator.ui.GoodGreen
import it.cdanet.cpeconfigurator.ui.KeyValue
import it.cdanet.cpeconfigurator.ui.Notice
import it.cdanet.cpeconfigurator.ui.NoticeKind
import it.cdanet.cpeconfigurator.ui.SecondaryButton
import it.cdanet.cpeconfigurator.ui.SectionCard
import it.cdanet.cpeconfigurator.ui.WarnAmber
import it.cdanet.cpeconfigurator.ui.wifiPanelIntent
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.Locale

private fun mbit(v: Double?) = v?.let { "%.1f".format(Locale.ITALY, it) } ?: "—"

/** The router Wi-Fi the phone is on now (never the CPE's, never mobile data), re-read every 2 s. */
@Composable
private fun rememberRouterLink(c: AppContainer): it.cdanet.cpeconfigurator.network.LinkInfo? {
    var link by remember { mutableStateOf(c.network.routerWifi()?.second) }
    LaunchedEffect(Unit) {
        while (true) {
            link = c.network.routerWifi()?.second
            delay(2000)
        }
    }
    return link
}

/**
 * One speed test at a time on the customer's router Wi-Fi: the signal gate (blocked under the
 * server's threshold, a warning just above), the live gauge, the result against the plan and, under
 * the minimum, what to check before testing again. Every test is saved on the server.
 */
@Composable
fun SpeedtestRunner(c: AppContainer, subject: SpeedtestSubject, attempts: Int, onResult: (SpeedResult, SpeedTarget?, Boolean?) -> Unit) {
    val scope = rememberCoroutineScope()
    var cfg by remember { mutableStateOf(c.speedtests.config()) }
    var target by remember { mutableStateOf<SpeedTarget?>(null) }
    var progress by remember { mutableStateOf<SpeedProgress?>(null) }
    var result by remember { mutableStateOf<SpeedResult?>(null) }
    var passed by remember { mutableStateOf<Boolean?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(subject) {
        cfg = c.speedtests.refreshConfig()
        target = c.speedtests.target(subject)
    }
    val link = rememberRouterLink(c)
    val signal = SpeedtestMath.signal(link?.wifiRssi, cfg)

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        target?.let { t ->
            val (d, u) = SpeedtestMath.minimum(t)
            KeyValue("Profilo del cliente", "${mbit(t.downMbps)} / ${mbit(t.upMbps)} Mbit/s · minimo ${t.minPct}%: ${mbit(d)} / ${mbit(u)}")
        } ?: if (subject.context != "tool") Text("Profilo del cliente non noto: la prova vale, senza confronto.", style = MaterialTheme.typography.bodySmall) else Unit
        when {
            link == null -> Notice("Il telefono non è sulla Wi-Fi del router: lo speedtest si fa solo sulla Wi-Fi, mai con i dati mobili.", NoticeKind.Warn)
            signal == SpeedtestMath.Signal.TooWeak -> Notice("Avvicinati al router: segnale ${link.wifiRssi} dBm, serve almeno ${cfg.wifiBlockDbm} dBm.", NoticeKind.Bad)
            signal == SpeedtestMath.Signal.Weak -> Notice("Segnale Wi-Fi debole (${link.wifiRssi} dBm): avvicinati al router per una misura affidabile.", NoticeKind.Warn)
            else -> Text("Wi-Fi: ${link.wifiSsid ?: "rete collegata"} · ${link.wifiRssi ?: "—"} dBm" + (link.linkSpeedMbps?.let { " · collegamento $it Mbit/s" } ?: ""), style = MaterialTheme.typography.bodySmall)
        }
        progress?.let { p ->
            Text(p.phase.label + (p.mbps?.let { " · ${mbit(it)} Mbit/s" } ?: ""), fontWeight = FontWeight.SemiBold)
            LinearProgressIndicator(progress = { p.fraction }, modifier = Modifier.fillMaxWidth())
        }
        result?.let { r ->
            KeyValue("Download", "${mbit(r.downMbps)} Mbit/s")
            KeyValue("Upload", "${mbit(r.upMbps)} Mbit/s")
            KeyValue("Ping / jitter", "%.0f / %.0f ms".format(Locale.ITALY, r.pingMs, r.jitterMs))
            when (passed) {
                true -> Banner("Velocità nei parametri del profilo.", GoodGreen)
                false -> {
                    Banner("Velocità sotto il minimo del profilo. Prima di ripetere il test controlla:", WarnAmber)
                    SpeedtestMath.CHECKLIST.forEach { Text("• $it", style = MaterialTheme.typography.bodySmall) }
                }
                null -> Unit
            }
        }
        error?.let { Notice(it, NoticeKind.Bad) }
        BusyButton(
            if (result == null) "Avvia speedtest" else "Ripeti il test",
            progress != null,
            Modifier.fillMaxWidth(),
            enabled = link != null && signal != SpeedtestMath.Signal.TooWeak,
        ) {
            val net = c.network.routerWifi()?.first ?: return@BusyButton
            error = null
            scope.launch {
                runCatching {
                    val fresh = c.speedtests.refreshConfig().also { cfg = it }
                    c.speedtests.measure(fresh, net) { p -> progress = p }
                }.onSuccess { r ->
                    val w = routerSnapshot(c)
                    val local = SpeedtestMath.passed(r.downMbps, r.upMbps, target)
                    val saved = c.speedtests.save(c.speedtests.post(subject, r, w, attempts + 1))
                    saved?.target?.let { target = it }
                    result = r
                    passed = saved?.passed ?: local
                    onResult(r, target, passed)
                }.onFailure { error = "Speedtest non riuscito: ${it.message ?: it.javaClass.simpleName}. Controlla che la Wi-Fi del router abbia Internet." }
                progress = null
            }
        }
    }
}

/** The router as the phone sees it now: scan, connected access point, link speed. */
@SuppressLint("MissingPermission")
@Suppress("DEPRECATION")
private fun routerSnapshot(c: AppContainer, aps: List<WifiAp> = readWifiScan(c.network.wifiManager)): RouterWifi? {
    val link = c.network.routerWifi()?.second ?: return null
    return SpeedtestMath.routerWifi(aps, link.wifiBssid, link.wifiSsid, link.linkSpeedMbps, link.wifiRssi)
}

/**
 * «Router e velocità», after the pointing: the customer's router ready, the phone on its Wi-Fi with
 * Internet, its channel and width checked, then the speed test against the plan, as many times as it
 * takes. Then the final check and the acceptance test.
 */
@Composable
fun RouterSpeedStep(c: AppContainer, onNext: () -> Unit) {
    val context = LocalContext.current
    val st by c.install.state.collectAsState()
    val r = st.router
    val cpeWifi by c.network.cpeWifi.collectAsState()
    val link = rememberRouterLink(c)
    val field by c.field.state.collectAsState()
    // the installation of this CPE (repointing): looked up again if the first try did not answer
    LaunchedEffect(st.job == null) {
        if (st.job == null) field.status?.macs?.let { c.install.lookupJob(it, again = true) }
    }

    SectionCard("1 · Router del cliente") {
        Text("Collega il router del cliente alla porta LAN della CPE e configuralo. Quando è pronto, prosegui.", style = MaterialTheme.typography.bodySmall)
        if (!r.ready) BusyButton("Router pronto, procedi", false, Modifier.fillMaxWidth()) { c.install.router { it.copy(ready = true) } }
        else Text("Router pronto.", color = GoodGreen, style = MaterialTheme.typography.bodySmall)
    }
    if (!r.ready) return

    val online = link != null && link.validated
    SectionCard("2 · Wi-Fi del router del cliente") {
        Text("Collega il telefono alla Wi-Fi del router del cliente: serve Internet su quella rete, non la Wi-Fi della CPE.", style = MaterialTheme.typography.bodySmall)
        if (cpeWifi == CpeWifi.Connected) TextButton(onClick = { c.network.leaveCpeWifi() }) { Text("Scollega dalla Wi-Fi della CPE") }
        when {
            link == null -> Notice("Il telefono non è collegato a una Wi-Fi.", NoticeKind.Warn)
            !link.validated -> Notice("${link.wifiSsid ?: "Questa Wi-Fi"}: nessun accesso a Internet. Controlla il router.", NoticeKind.Warn)
            else -> KeyValue("Wi-Fi", "${link.wifiSsid ?: "rete collegata"} · ${link.wifiRssi ?: "—"} dBm · Internet ok")
        }
        SecondaryButton(onClick = { runCatching { context.startActivity(wifiPanelIntent()) } }, modifier = Modifier.fillMaxWidth()) { Text("Apri le impostazioni Wi-Fi") }
    }
    if (!online) return

    RouterChannelCard(c, r)
    if (r.wifi == null) return

    SectionCard("4 · Speedtest") {
        val subject = SpeedtestSubject(
            context = when {
                st.job != null -> "acceptance"
                st.workOrderId != null -> "work_order"
                else -> "cpe"
            },
            jobId = st.job?.id,
            workOrderId = st.workOrderId,
            mac = st.job?.mac ?: field.status?.macs?.firstOrNull(),
        )
        SpeedtestRunner(c, subject, r.attempts) { res, target, passed ->
            c.install.router { it.copy(last = res, target = target, passed = passed, attempts = it.attempts + 1, gaveUp = null) }
        }
        if (r.passed == false && r.gaveUp == null) {
            TextButton(onClick = { c.install.router { it.copy(gaveUp = "velocità") } }) { Text("Prosegui con la velocità sotto il minimo") }
            Text("Il collaudo uscirà con riserva per la velocità: il NOC potrà accettarlo.", style = MaterialTheme.typography.bodySmall)
        }
        if (r.gaveUp != null) Text("Proseguo con la velocità sotto il minimo (${r.attempts} prove).", color = WarnAmber, style = MaterialTheme.typography.bodySmall)
    }
    BusyButton("Avanti: verifica finale", false, Modifier.fillMaxWidth(), enabled = r.done) { onNext() }
}

/** «3 · Canale e ampiezza»: what the router uses, what is around it, what to change. */
@Composable
private fun RouterChannelCard(c: AppContainer, r: RouterCheck) {
    var aps by remember { mutableStateOf<List<WifiAp>>(emptyList()) }
    var scans by remember { mutableStateOf(0) }
    var changed by remember { mutableStateOf(r.changed.orEmpty()) }
    LaunchedEffect(scans) {
        @Suppress("DEPRECATION")
        runCatching { c.network.wifiManager.startScan() }
        delay(3000)
        aps = readWifiScan(c.network.wifiManager)
    }
    val w = remember(aps) { routerSnapshot(c, aps) }
    val advice = remember(aps, w) { w?.let { SpeedtestMath.advice(aps, it) }.orEmpty() }
    SectionCard("3 · Canale e ampiezza del router") {
        if (w == null || w.channel == null) {
            Text("Lettura delle reti intorno…", style = MaterialTheme.typography.bodySmall)
        } else {
            KeyValue("Rete", "${w.ssid} · ${w.band} GHz")
            KeyValue("Canale", "${w.channel} · ${w.widthMhz} MHz")
            KeyValue("Altre reti", "${w.neighborsSameChannel} sullo stesso canale · ${w.neighborsOverlapping} sovrapposte")
            if (advice.isEmpty()) Text("Canale e ampiezza vanno bene.", color = GoodGreen, style = MaterialTheme.typography.bodySmall)
            else {
                Text("Da cambiare sul router:", fontWeight = FontWeight.SemiBold)
                advice.forEach { Text("• $it", style = MaterialTheme.typography.bodySmall) }
                OutlinedTextField(changed, { changed = it.take(200) }, label = { Text("Cosa hai cambiato (facoltativo)") }, modifier = Modifier.fillMaxWidth())
                Text("Dopo una modifica il telefono si ricollega da solo: attendi e tocca «Rileggi».", style = MaterialTheme.typography.bodySmall)
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TextButton(onClick = { scans++ }) { Text("Rileggi") }
            TextButton(onClick = { c.install.router { it.copy(wifi = w, changed = changed.trim().ifBlank { null }) } }, enabled = w?.channel != null) {
                Text(if (r.wifi == null) "Va bene, procedi" else "Aggiorna")
            }
        }
    }
}

/** Strumenti → Speedtest: the same test, on any Wi-Fi with Internet, saved as a tool test. */
@Composable
fun SpeedtestToolScreen(c: AppContainer) {
    SectionCard("Speedtest") {
        Text("Misura download, upload e ping verso il server di speedtest CDA Net, sulla Wi-Fi a cui è collegato il telefono (mai con i dati mobili).", style = MaterialTheme.typography.bodySmall)
        SpeedtestRunner(c, SpeedtestSubject("tool"), 0) { _, _, _ -> }
    }
}
