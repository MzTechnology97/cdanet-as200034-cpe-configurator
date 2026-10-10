package it.cdanet.cpeconfigurator.field

import kotlin.math.roundToInt

/** Altitude of the phone above sea level from its GPS; [mslM] null = this phone does not give it. */
data class GpsAltitude(val mslM: Double?, val accuracyM: Double?)

/**
 * On the roof the phone is next to the CPE: its GPS altitude minus the terrain altitude gives the
 * height of the CPE above the ground, instead of typing it. Used only when the GPS says it is
 * precise; otherwise the technician types the height.
 */
object RoofAltitude {
    /** Worst vertical accuracy accepted, metres (a typical phone GPS is 3-15 m). */
    const val MAX_ACCURACY_M = 10.0

    /** A roof is not higher than this above the ground: more means a wrong GPS fix. */
    const val MAX_HEIGHT_M = 60.0

    sealed interface Result {
        data class Height(val metres: Double, val mslM: Double, val accuracyM: Double) : Result
        data class Unusable(val why: String) : Result
    }

    fun heightAboveGround(gps: GpsAltitude?, groundM: Double?): Result {
        val msl = gps?.mslM ?: return Result.Unusable("Questo telefono non dà l'altitudine sul livello del mare (serve Android 14 o più recente): inserisci l'altezza a mano.")
        if (groundM == null) return Result.Unusable("Quota del terreno non disponibile: inserisci l'altezza a mano.")
        val acc = gps.accuracyM
        if (acc == null || acc > MAX_ACCURACY_M) {
            return Result.Unusable("Altitudine GPS poco precisa${acc?.let { " (±${it.roundToInt()} m)" } ?: ""}: resta all'aperto qualche secondo e riprova, oppure inserisci l'altezza a mano.")
        }
        val h = msl - groundM
        if (h < -acc) return Result.Unusable("Il GPS dà una quota sotto il terreno: inserisci l'altezza a mano.")
        if (h > MAX_HEIGHT_M) return Result.Unusable("Il GPS dà ${h.roundToInt()} m dal suolo, non è credibile: inserisci l'altezza a mano.")
        // to the half metre, at least half a metre (a CPE on the ground still has a pole)
        val rounded = (maxOf(0.5, h) * 2).roundToInt() / 2.0
        return Result.Height(rounded, msl, acc)
    }
}
