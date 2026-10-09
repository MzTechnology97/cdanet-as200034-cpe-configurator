package it.cdanet.cpeconfigurator

import it.cdanet.cpeconfigurator.data.PointingApDto
import it.cdanet.cpeconfigurator.data.SignalEstimateDto
import it.cdanet.cpeconfigurator.field.AirosStatus
import it.cdanet.cpeconfigurator.field.SurveyAp
import it.cdanet.cpeconfigurator.install.ApAdvisor
import it.cdanet.cpeconfigurator.install.InstallMode
import it.cdanet.cpeconfigurator.install.InstallStep
import it.cdanet.cpeconfigurator.install.SystemCfgRelink
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class InstallWizardTest {
    private val cfg = listOf(
        "aaa.1.status=enabled",
        "wireless.1.ssid=CDA-NET-N2-D01",
        "wireless.1.ap=24:A4:3C:00:00:01",
        "wpasupplicant.profile.1.network.1.ssid=CDA-NET-N2-D01",
        "wpasupplicant.profile.1.network.1.psk=vecchia-chiave",
        "wpasupplicant.profile.1.network.1.key_mgmt.1.name=WPA-PSK",
        "resolv.host.1.name=ROSSI MARIO",
        "",
    ).joinToString("\n")

    @Test
    fun relinkRewritesSsidKeyAndReleasesTheApLock() {
        val r = SystemCfgRelink.relink(cfg, "CDA-NET-N3-D02", "nuova=chiave#1")
        assertEquals(2, r.ssidLines)
        assertEquals(1, r.pskLines)
        assertTrue(r.text.contains("wireless.1.ssid=CDA-NET-N3-D02\n"))
        assertTrue(r.text.contains("wpasupplicant.profile.1.network.1.ssid=CDA-NET-N3-D02\n"))
        assertTrue(r.text.contains("wpasupplicant.profile.1.network.1.psk=nuova=chiave#1\n"))
        assertTrue(r.text.contains("wireless.1.ap=\n"))
        assertTrue("other lines untouched", r.text.contains("resolv.host.1.name=ROSSI MARIO\n") && r.text.contains("key_mgmt.1.name=WPA-PSK\n"))
        assertTrue(r.text.endsWith("\n"))
        assertFalse(r.text.contains("vecchia-chiave"))

        val locked = SystemCfgRelink.relink(cfg, "CDA-NET-N3-D02", "k1234567", lockMac = "24:A4:3C:00:00:09")
        assertTrue(locked.text.contains("wireless.1.ap=24:A4:3C:00:00:09\n"))
    }

    @Test(expected = IllegalArgumentException::class)
    fun relinkRefusesLineBreaks() {
        SystemCfgRelink.relink(cfg, "CDA-NET-N3-D02", "chiave\nwireless.1.ssid=altro")
    }

    @Test
    fun relinkReportsAnUnknownConfig() {
        val r = SystemCfgRelink.relink("system.date=2024\n", "CDA-NET-N3-D02", "k1234567")
        assertEquals(0, r.ssidLines)
        assertEquals(0, r.pskLines)
    }

    private fun survey(ssid: String, signal: Int, mac: String = "24:A4:3C:00:00:${(signal and 0xff).toString(16).padStart(2, '0')}") =
        SurveyAp(mac, ssid, 5640, 128, signal, -95, "11ACVHT80", "WPA2", true)

    private fun ap(ssid: String, distanceM: Int, estimate: Int? = null) =
        PointingApDto(id = ssid, name = "AP $ssid", ssid = ssid, status = "active", bearing = 120, direction = "SE", distanceM = distanceM, estimate = estimate?.let { SignalEstimateDto(signalDbm = it) })

    @Test
    fun surveyChoiceOnlyCdaNetAndCloserApWhenSignalsAreEquivalent() {
        val list = ApAdvisor.fromSurvey(
            listOf(survey("CDA-NET-N2-D01", -70), survey("CDA-NET-N3-D02", -63), survey("CDA-NET-N4-D01", -62), survey("Vicino", -40)),
            listOf(ap("CDA-NET-N3-D02", 1800), ap("CDA-NET-N4-D01", 6400), ap("CDA-NET-N2-D01", 900)),
            currentSsid = "CDA-NET-N2-D01",
            configured = setOf("CDA-NET-N2-D01", "CDA-NET-N3-D02", "CDA-NET-N4-D01"),
        )
        assertEquals(listOf("CDA-NET-N3-D02", "CDA-NET-N4-D01", "CDA-NET-N2-D01"), list.map { it.ssid })
        assertTrue("-63 and -62 are equivalent: the closer AP wins", list[0].recommended)
        assertTrue(list.last().current)
        assertEquals("CDA-NET-N3-D02", ApAdvisor.betterThanCurrent(list)?.ssid)
    }

    @Test
    fun apWithoutKeyIsNeverRecommendedAndSmallGainsDoNotMoveTheCpe() {
        val list = ApAdvisor.fromSurvey(
            listOf(survey("CDA-NET-N2-D01", -64), survey("CDA-NET-N5-D01", -55), survey("CDA-NET-N3-D02", -61)),
            emptyList(),
            currentSsid = "CDA-NET-N2-D01",
            configured = setOf("CDA-NET-N2-D01", "CDA-NET-N3-D02"),
        )
        assertFalse(list.first { it.ssid == "CDA-NET-N5-D01" }.usable)
        assertEquals("CDA-NET-N3-D02", list.first { it.recommended }.ssid)
        assertNull("3 dB are not worth a reboot", ApAdvisor.betterThanCurrent(list))
    }

    @Test
    fun beforeInstallByExpectedSignalThenDistance() {
        val list = ApAdvisor.beforeInstall(
            listOf(ap("CDA-NET-N2-D01", 4000, -68), ap("CDA-NET-N3-D02", 2500, -60), ap("CDA-NET-N4-D01", 1200, -61), ap("PtP-Link", 300, -40)),
            configured = null,
        )
        assertEquals(listOf("CDA-NET-N4-D01", "CDA-NET-N3-D02", "CDA-NET-N2-D01"), list.map { it.ssid })
        assertTrue(list[0].recommended)
    }

    @Test
    fun repointingSkipsTheConfiguration() {
        assertEquals(InstallStep.entries, InstallStep.of(InstallMode.New))
        assertEquals(listOf(InstallStep.Verify, InstallStep.Link, InstallStep.Aim, InstallStep.Final), InstallStep.of(InstallMode.Repoint))
    }

    @Test
    fun statusReadsModulationAndCpeMacs() {
        val s = AirosStatus.parse(
            """{"host":{"hostname":"ROSSI MARIO"},"wireless":{"essid":"CDA-NET-N2-D01","sta":[{"mac":"24:A4:3C:00:00:01","signal":-61,"noisefloor":-96,"rx_idx":9,"rx_nss":2,"tx_idx":7,"tx_nss":1}]},
               "interfaces":[{"ifname":"eth0","hwaddr":"f4:92:bf:11:22:33"},{"ifname":"ath0","hwaddr":"F4:92:BF:11:22:34"},{"ifname":"lo","hwaddr":"00:00:00:00:00:00"}]}""",
        )
        assertEquals("256QAM 5/6 ×2", s.rxModulation)
        assertEquals("64QAM 5/6", s.txModulation)
        assertEquals(35, s.snr)
        assertEquals(listOf("F4:92:BF:11:22:33", "F4:92:BF:11:22:34"), s.macs)
    }
}
