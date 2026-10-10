package it.cdanet.cpeconfigurator

import it.cdanet.cpeconfigurator.field.FirmwareVersion
import it.cdanet.cpeconfigurator.field.FirmwareVersion.State
import org.junit.Assert.assertEquals
import org.junit.Test

class FirmwareVersionTest {
    @Test
    fun newerIsFineOlderIsToUpdate() {
        assertEquals(State.Ok, FirmwareVersion.state("XC.qca956x.v8.7.4.45112.210415.1103", "8.7.4"))
        assertEquals(State.Ok, FirmwareVersion.state("XC.qca956x.v8.7.11.46972.220614.0420", "8.7.4"))
        assertEquals(State.Ok, FirmwareVersion.state("WA.ipq40xx.v8.7.18", "8.7.4"))
        assertEquals(State.Old, FirmwareVersion.state("XC.qca956x.v8.6.2", "8.7.4"))
        assertEquals(State.Legacy, FirmwareVersion.state("XW.ar934x.v6.3.11.33396", "8.7.4"))
        assertEquals(State.Unknown, FirmwareVersion.state("boh", "8.7.4"))
        assertEquals(listOf(8, 7, 11), FirmwareVersion.parse("XC.qca956x.v8.7.11.46972"))
    }
}
