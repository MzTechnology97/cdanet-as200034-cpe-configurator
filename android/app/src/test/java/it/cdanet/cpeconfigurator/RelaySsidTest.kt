package it.cdanet.cpeconfigurator

import it.cdanet.cpeconfigurator.field.SurveyAp
import it.cdanet.cpeconfigurator.install.ApAdvisor
import it.cdanet.cpeconfigurator.provisioning.ProvisionForm
import it.cdanet.cpeconfigurator.provisioning.ProvisioningController
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RelaySsidTest {
    @Test
    fun formBuildsTheRelaySsid() {
        assertEquals("CDA-NET-N6-D02", ProvisionForm(node = 6, district = 2).ssid)
        assertEquals("CDA-NET-N6-D02-R1", ProvisionForm(node = 6, district = 2, relay = 1).ssid)
        val m = ProvisioningController.SSID_PARTS.find("CDA-NET-N6-D02-R3")!!
        assertEquals(listOf("6", "02", "3"), m.groupValues.drop(1))
        assertEquals("", ProvisioningController.SSID_PARTS.find("CDA-NET-N6-D02")!!.groupValues[3])
    }

    @Test
    fun relayApsAreCustomerApsInTheSurvey() {
        val heard = listOf(
            SurveyAp("24:A4:3C:00:00:01", "CDA-NET-N6-D02-R1", 5640, 128, -58, -95, "", "WPA2", true),
            SurveyAp("24:A4:3C:00:00:02", "PTP MATRICE VS A.7_2", 5395, 79, -50, -95, "", "WPA2", true),
        )
        val choices = ApAdvisor.fromSurvey(heard, emptyList(), null, null)
        assertEquals(listOf("CDA-NET-N6-D02-R1"), choices.map { it.ssid })
        assertTrue(choices[0].recommended)
        assertEquals(6 to 2, heard[0].cdaNet)
    }
}
