package it.cdanet.cpeconfigurator

import it.cdanet.cpeconfigurator.data.AppJson
import it.cdanet.cpeconfigurator.ui.screens.DiagnosisDto
import it.cdanet.cpeconfigurator.ui.screens.diagnosable
import it.cdanet.cpeconfigurator.ui.screens.diagnosedAtOnce
import it.cdanet.cpeconfigurator.ui.screens.startsWithEmoji
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RemoteDiagnosisTest {
    @Test
    fun theInstallersAnswerAndTheAdminsOneBothRead() {
        val field = AppJson.decodeFromString(
            DiagnosisDto.serializer(),
            """{"at":"2026-10-15T18:02:11Z","verdict":"Segnale in calo","findings":[{"level":"warn","code":"signal_drop","title":"Segnale in calo","detail":"-71 dBm, era -63","action":"Ripuntare la CPE"},{"level":"ok","code":"network_ok","title":"AP regolare","detail":"","action":""}],"cpe":{"found":true,"online":true,"signal":-71},"ap":{"name":"AP-Nord","online":true}}""",
        )
        assertEquals(listOf("signal_drop", "network_ok"), field.findings.map { it.code })
        assertEquals(-71, field.cpe?.signal)
        // the admin's answer has more (subject, facts): read the same, the rest is in the console
        val admin = AppJson.decodeFromString(
            DiagnosisDto.serializer(),
            """{"at":"2026-10-15T18:02:11Z","verdict":"Cliente sospeso","findings":[{"level":"bad","code":"suspended","title":"Cliente sospeso","detail":"","action":"Sentire l'ufficio"}],"subject":{"customer":"ROSSI MARIO"},"facts":{"ap":{"name":"AP-Nord","online":true,"cpeTotal":12,"cpeOffline":1}}}""",
        )
        assertEquals("Cliente sospeso", admin.verdict)
        assertEquals(null, admin.cpe)
    }

    @Test
    fun faultsAndRepointingsAreDiagnosedAtOnce() {
        assertTrue(diagnosedAtOnce("repair") && diagnosedAtOnce("repoint"))
        assertFalse(diagnosedAtOnce("new"))
        assertFalse(diagnosable("new") || diagnosable("survey"))
    }
}

class NotificationTitleTest {
    @Test
    fun titlesWithTheirOwnEmojiGetNoSecondIcon() {
        listOf("📉 Segnale in calo su 3 CPE", "🔋 POP Nord a batteria", "✅ POP Nord: batteria in carica", "⚠️ ISP Billing: non funziona", "❌ Configurazione fallita")
            .forEach { t -> assertTrue(t, startsWithEmoji(t)) }
        listOf("Nuovo intervento", "3 CPE da controllare", "«Rossi»", "").forEach { t -> assertFalse(t, startsWithEmoji(t)) }
    }
}
