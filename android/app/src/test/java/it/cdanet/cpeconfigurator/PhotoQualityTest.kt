package it.cdanet.cpeconfigurator

import it.cdanet.cpeconfigurator.field.PhotoChecklist
import it.cdanet.cpeconfigurator.field.PhotoQuality
import it.cdanet.cpeconfigurator.field.PhotoType
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

class PhotoQualityTest {
    private val w = 120
    private val h = 90

    /** A sharp picture: a checkerboard with fine detail. */
    private fun sharp(): IntArray = IntArray(w * h) { i -> if (((i % w) / 4 + (i / w) / 4) % 2 == 0) 220 else 40 }

    /** The same picture blurred: each pixel the mean of its 9×9 neighbourhood. */
    private fun blurred(src: IntArray): IntArray = IntArray(w * h) { i ->
        val x = i % w
        val y = i / w
        var s = 0
        var n = 0
        for (dy in -4..4) for (dx in -4..4) {
            val xx = x + dx
            val yy = y + dy
            if (xx in 0 until w && yy in 0 until h) {
                s += src[yy * w + xx]
                n++
            }
        }
        s / n
    }

    private fun check(g: IntArray, sha: String) = PhotoQuality.Check(sha, PhotoQuality.laplacianVariance(g, w, h), PhotoQuality.brightness(g), PhotoQuality.dHash(g, w, h))

    @Test
    fun aBlurredPhotoIsFlagged() {
        val s = sharp()
        assertTrue(PhotoQuality.problems(check(s, "a"), emptyList()).isEmpty())
        assertEquals(listOf("mossa o sfocata"), PhotoQuality.problems(check(blurred(s), "b"), emptyList()))
    }

    @Test
    fun aDarkPhotoIsFlagged() {
        val dark = IntArray(w * h) { i -> if (i % 7 == 0) 60 else 10 }
        assertEquals(listOf("troppo scura"), PhotoQuality.problems(check(dark, "d"), emptyList()))
    }

    @Test
    fun theSameShotTwiceAndNearlyTheSameScene() {
        val s = sharp()
        val first = check(s, "a")
        assertTrue(PhotoQuality.duplicate(check(s, "a"), listOf(first)))
        // the same scene a moment later: a little noise, other bytes
        val rnd = Random(1)
        val again = IntArray(s.size) { i -> (s[i] + rnd.nextInt(-6, 7)).coerceIn(0, 255) }
        val c = check(again, "b")
        assertFalse(PhotoQuality.duplicate(c, listOf(first)))
        assertTrue("quasi uguale a un'altra foto già fatta" in PhotoQuality.problems(c, listOf(first)))
        // a different picture: fine
        val other = IntArray(w * h) { i -> if ((i % w) < w / 2) 200 else 50 }
        assertFalse("quasi uguale a un'altra foto già fatta" in PhotoQuality.problems(check(other, "c"), listOf(first)))
    }

    @Test
    fun fourPhotosForANewInstallationOnly() {
        assertEquals(listOf(PhotoType.Bracket, PhotoType.Router), PhotoChecklist.missing(listOf(PhotoType.Antenna, PhotoType.Cabling, PhotoType.Other), newInstall = true))
        assertTrue(PhotoChecklist.missing(emptyList(), newInstall = false).isEmpty())
        assertEquals(PhotoType.Bracket, PhotoType.ofCaption("Staffa / palo"))
        assertEquals(PhotoType.Router, PhotoType.ofKey("router"))
    }
}
