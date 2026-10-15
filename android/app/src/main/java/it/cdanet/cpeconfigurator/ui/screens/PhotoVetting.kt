package it.cdanet.cpeconfigurator.ui.screens

import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import it.cdanet.cpeconfigurator.field.PhotoCapture
import it.cdanet.cpeconfigurator.field.PhotoQuality
import it.cdanet.cpeconfigurator.field.PhotoType
import it.cdanet.cpeconfigurator.ui.GoodGreen
import it.cdanet.cpeconfigurator.ui.PrimaryButton
import it.cdanet.cpeconfigurator.ui.SecondaryButton
import it.cdanet.cpeconfigurator.ui.SectionCard
import it.cdanet.cpeconfigurator.ui.WarnAmber
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** A photo just taken, held back because something may be wrong with it: retaken or kept. */
class PhotoToReview(val caption: String, val jpeg: ByteArray, val thumb: Bitmap?, val problems: List<String>)

/** What the checks say of a new photo against the ones already added. */
class PhotoVerdict(val duplicate: Boolean, val problems: List<String>)

suspend fun vetPhoto(jpeg: ByteArray, others: List<ByteArray>): PhotoVerdict = withContext(Dispatchers.Default) {
    val new = PhotoCapture.check(jpeg)
    val old = others.map { PhotoCapture.check(it) }
    PhotoVerdict(PhotoQuality.duplicate(new, old), PhotoQuality.problems(new, old))
}

/** «Foto mossa o sfocata: rifalla?»: the photo, what may be wrong, Rifai / Tieni comunque. */
@Composable
fun PhotoReviewCard(r: PhotoToReview, onRetake: () -> Unit, onKeep: () -> Unit) {
    SectionCard("Controlla la foto «${r.caption}»") {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            r.thumb?.let { Image(it.asImageBitmap(), contentDescription = r.caption, modifier = Modifier.size(96.dp), contentScale = ContentScale.Crop) }
            Text("Sembra ${r.problems.joinToString(" e ")}. Nel verbale deve vedersi bene.", color = WarnAmber, modifier = Modifier.weight(1f))
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PrimaryButton(onClick = onRetake) { Text("Rifai la foto") }
            SecondaryButton(onClick = onKeep) { Text("Tieni comunque") }
        }
    }
}

/** The required photos with a tick when taken: «✓ Antenna  ✗ Router cliente». */
@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
fun PhotoChecklistRow(required: List<PhotoType>, missing: List<PhotoType>) {
    androidx.compose.foundation.layout.FlowRow(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        required.forEach { t ->
            val ok = t !in missing
            Text(
                "${if (ok) "✓" else "✗"} ${t.label}",
                color = if (ok) GoodGreen else WarnAmber,
                fontWeight = if (ok) FontWeight.Normal else FontWeight.SemiBold,
                style = MaterialTheme.typography.bodyMedium,
            )
        }
    }
}
