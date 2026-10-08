package it.cdanet.cpeconfigurator.field

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import androidx.core.content.FileProvider
import java.io.ByteArrayOutputStream
import java.io.File

/** Installation photos: full-size camera shot in the app cache, then a small upright JPEG for upload. */
object PhotoCapture {
    private const val MAX_SIDE = 1600

    fun newTarget(context: Context): Pair<File, Uri> {
        val dir = File(context.cacheDir, "photos").apply { mkdirs() }
        val file = File.createTempFile("cpe-", ".jpg", dir)
        return file to FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
    }

    /** Downscaled (max 1600 px), EXIF-rotated, ~200-400 KB. Deletes the original. */
    fun compress(file: File, quality: Int = 82): ByteArray {
        try {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(file.path, bounds)
            var sample = 1
            while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= MAX_SIDE) sample *= 2
            val raw = BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample })
                ?: throw IllegalStateException("Foto non leggibile")
            val rotation = when (ExifInterface(file.path).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
                ExifInterface.ORIENTATION_ROTATE_90 -> 90f
                ExifInterface.ORIENTATION_ROTATE_180 -> 180f
                ExifInterface.ORIENTATION_ROTATE_270 -> 270f
                else -> 0f
            }
            val scale = minOf(1f, MAX_SIDE.toFloat() / maxOf(raw.width, raw.height))
            val m = Matrix().apply { postScale(scale, scale); postRotate(rotation) }
            val out = Bitmap.createBitmap(raw, 0, 0, raw.width, raw.height, m, true)
            return ByteArrayOutputStream().use { bos ->
                out.compress(Bitmap.CompressFormat.JPEG, quality, bos)
                if (out !== raw) out.recycle()
                raw.recycle()
                bos.toByteArray()
            }
        } finally {
            file.delete()
        }
    }

    fun thumbnail(jpeg: ByteArray): Bitmap? = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size, BitmapFactory.Options().apply { inSampleSize = 8 })
}
