package it.cdanet.cpeconfigurator

import it.cdanet.cpeconfigurator.firmware.AirosImage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class AirosImageTest {
    private fun header(build: String): ByteArray {
        val b = ByteArray(260)
        "UBNT".toByteArray(Charsets.ISO_8859_1).copyInto(b)
        build.toByteArray(Charsets.ISO_8859_1).copyInto(b, 4)
        return b
    }

    @Test
    fun readsBuildFromCpeAndImage() {
        val cpe = AirosImage.parseBuild("XC.qca956x.v8.7.11.46972.220614.0420\n")
        assertEquals("XC", cpe?.platform)
        assertEquals("8.7.11", cpe?.version)
        assertEquals("8.7.4", AirosImage.parseHeader(header("XC.qca956x.v8.7.4.45112.210415.1103"))?.version)
        assertNull(AirosImage.parseHeader(ByteArray(260)))
        assertNull(AirosImage.parseBuild("BusyBox v1.25"))
    }

    @Test
    fun blocksTheWrongPlatform() {
        val cpe = AirosImage.parseBuild("WA.ar934x.v8.7.11.46972.220614.0420")
        val xc = AirosImage.parseHeader(header("XC.qca956x.v8.7.4.45112.210415.1103"))
        assertNotNull(AirosImage.refusal(cpe, xc))
        assertNotNull(AirosImage.refusal(null, xc))
        assertNotNull(AirosImage.refusal(cpe, null))
        assertNull(AirosImage.refusal(AirosImage.parseBuild("XC.qca956x.v8.7.11.46972.220614.0420"), xc))
    }

    @Test
    fun freeSpaceFromBusyboxDf() {
        val df = "Filesystem           1K-blocks      Used Available Use% Mounted on\ntmpfs                    30116      2044     28072   7% /tmp\n"
        assertEquals(28072L, AirosImage.freeKb(df))
        assertNull(AirosImage.freeKb(""))
    }
}
