package it.cdanet.cpeconfigurator

import it.cdanet.cpeconfigurator.data.OutageImpactDto
import it.cdanet.cpeconfigurator.data.PopPowerDto
import it.cdanet.cpeconfigurator.ui.screens.powerText
import org.junit.Assert.assertEquals
import org.junit.Test

class PopPowerTextTest {
    @Test
    fun whatAnInstallerReads() {
        // installers get state, charge and discharging only
        assertEquals("Batteria 24% · in scarica · bassa", powerText(PopPowerDto(status = "warn", soc = 24.4, batteryState = "discharging")))
        assertEquals("Batteria 87% · in carica", powerText(PopPowerDto(status = "ok", soc = 87.0, batteryState = "charging")))
        assertEquals("Batteria · nessun dato da 2 h", powerText(PopPowerDto(status = "silent", lastTs = 1_000L), nowSec = 1_000L + 2 * 3600 + 60))
        assertEquals("Batteria 30% · 2 allarmi", powerText(PopPowerDto(status = "alarm", soc = 30.0, alarms = 2)))
        assertEquals("Batteria 64% · off-grid · in scarica", powerText(PopPowerDto(soc = 64.0, batteryState = "discharging", offGrid = true)))
    }

    @Test
    fun theImpactKnowsItsPop() {
        assertEquals("site-n2", OutageImpactDto(type = "pop", id = "site-n2").pop)
        assertEquals("site-n2", OutageImpactDto(type = "ap", id = "ap-1", popId = "site-n2").pop)
    }
}
