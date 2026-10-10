package it.cdanet.cpeconfigurator.ui.screens

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PorterDuff
import android.graphics.PorterDuffColorFilter
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.pdf.PdfDocument
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.text.TextPaint
import android.text.TextUtils
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.compose.ui.graphics.toArgb
import it.cdanet.cpeconfigurator.tools.topology.Graph
import it.cdanet.cpeconfigurator.tools.topology.GraphLink
import it.cdanet.cpeconfigurator.tools.topology.LinkKind
import it.cdanet.cpeconfigurator.tools.topology.TopoGraph
import it.cdanet.cpeconfigurator.tools.topology.VendorBadges
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * The topology as an image (PNG) or a vector document (PDF), drawn like the screen (same layout, icons,
 * badges, ports) on a white page with title and legend, and shared with any app.
 */
object TopologyExport {
    private const val HEADER = 70f
    private const val FOOTER = 60f
    private const val MARGIN = 24f

    private val INK = 0xFF1F2937.toInt()
    private val MUTED = 0xFF6B7280.toInt()
    private val LINE = 0xFF374151.toInt()
    private val THIN = 0xFF9CA3AF.toInt()
    private val WIRELESS = 0xFF0EA5E9.toInt()

    private fun file(context: Context, ext: String): File {
        val dir = File(context.cacheDir, "exports").apply { mkdirs() }
        dir.listFiles()?.forEach { it.delete() } // only the last export is kept
        val stamp = SimpleDateFormat("yyyyMMdd-HHmm", Locale.ITALY).format(Date())
        return File(dir, "topologia-$stamp.$ext")
    }

    fun png(context: Context, graph: Graph, infraOnly: Boolean, title: String): File {
        val layout = TopoGraph.layout(graph, infraOnly)
        val w = layout.width + 2 * MARGIN
        val h = layout.height + HEADER + FOOTER
        // 2 pixels per unit, smaller for very large maps (at most ~40 Mpixel, 8000 px a side)
        val scale = minOf(2f, 8000f / w, 8000f / h, kotlin.math.sqrt(40_000_000f / (w * h)))
        val bmp = Bitmap.createBitmap((w * scale).toInt(), (h * scale).toInt(), Bitmap.Config.ARGB_8888)
        Canvas(bmp).apply { scale(scale, scale); draw(context, this, graph, layout, title) }
        val out = file(context, "png")
        out.outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bmp.recycle()
        return out
    }

    fun pdf(context: Context, graph: Graph, infraOnly: Boolean, title: String): File {
        val layout = TopoGraph.layout(graph, infraOnly)
        // one page as big as the map (1 unit = 1 pt), at least A4 landscape wide
        val w = maxOf(842f, layout.width + 2 * MARGIN)
        val h = maxOf(595f, layout.height + HEADER + FOOTER)
        val doc = PdfDocument()
        val page = doc.startPage(PdfDocument.PageInfo.Builder(w.toInt(), h.toInt(), 1).create())
        draw(context, page.canvas, graph, layout, title)
        doc.finishPage(page)
        val out = file(context, "pdf")
        out.outputStream().use { doc.writeTo(it) }
        doc.close()
        return out
    }

    /** Folder of the phone's Downloads where the exports are saved. */
    const val DOWNLOAD_FOLDER = "Download/CDA Net"

    /**
     * Copies [f] into Download/CDA Net (Android 10+: no permission needed) and returns its Uri;
     * null on older Android, where the export is shared instead.
     */
    fun saveToDownloads(context: Context, f: File, mime: String): Uri? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return null
        val r = context.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, f.name)
            put(MediaStore.MediaColumns.MIME_TYPE, mime)
            put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/CDA Net")
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val uri = r.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return null
        try {
            r.openOutputStream(uri)!!.use { out -> f.inputStream().use { it.copyTo(out) } }
            r.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
        } catch (e: Exception) {
            r.delete(uri, null, null)
            throw e
        }
        return uri
    }

    /** Opens a saved export with the phone's viewer (gallery, PDF reader). */
    fun open(context: Context, uri: Uri, mime: String) {
        val view = Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        runCatching { context.startActivity(view) }
            .onFailure { android.widget.Toast.makeText(context, "Nessuna app per aprire il file", android.widget.Toast.LENGTH_SHORT).show() }
    }

    fun share(context: Context, f: File, mime: String) {
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", f)
        val send = Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uri).putExtra(Intent.EXTRA_SUBJECT, f.nameWithoutExtension)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        context.startActivity(Intent.createChooser(send, "Esporta topologia").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    private fun stroke(color: Int, width: Float, dash: FloatArray? = null) = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        this.color = color
        strokeWidth = width
        strokeJoin = Paint.Join.ROUND
        if (dash != null) pathEffect = DashPathEffect(dash, 0f)
    }

    private fun linkPaint(k: LinkKind) = when (k) {
        LinkKind.Lldp, LinkKind.Cdp, LinkKind.Mndp, LinkKind.Uplink -> stroke(LINE, 2.5f)
        LinkKind.Wireless -> stroke(WIRELESS, 2f, floatArrayOf(8f, 5f))
        LinkKind.Fdb -> stroke(THIN, 1.6f)
        LinkKind.Assumed -> stroke(THIN, 1.6f, floatArrayOf(2f, 5f))
    }

    private fun text(size: Float, color: Int = INK, bold: Boolean = false) = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
        textSize = size
        this.color = color
        typeface = if (bold) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
    }

    private fun Canvas.pill(label: String, cx: Float, cy: Float, color: Int = MUTED) {
        val p = text(8.5f, color, bold = true)
        val tw = p.measureText(label)
        val r = RectF(cx - tw / 2 - 4, cy - 7, cx + tw / 2 + 4, cy + 6)
        drawRoundRect(r, 6f, 6f, Paint(Paint.ANTI_ALIAS_FLAG).apply { this.color = 0xFFFFFFFF.toInt() })
        drawText(label, cx - tw / 2, cy + 3, p)
    }

    private fun Canvas.centered(label: String, cx: Float, y: Float, width: Float, p: TextPaint) {
        val t = TextUtils.ellipsize(label, p, width, TextUtils.TruncateAt.END).toString()
        drawText(t, cx - p.measureText(t) / 2, y, p)
    }

    private fun draw(context: Context, c: Canvas, g: Graph, l: TopoGraph.Layout, title: String) {
        c.drawColor(0xFFFFFFFF.toInt())
        // header
        c.drawText(title, MARGIN, 30f, text(16f, bold = true))
        val devices = g.nodes.count { it.id != TopoGraph.INTERNET }
        val certain = g.links.count { it.kind.certain && it.kind != LinkKind.Uplink }
        c.drawText(
            "${SimpleDateFormat("dd/MM/yyyy HH:mm", Locale.ITALY).format(Date())} · $devices dispositivi · $certain collegamenti certi · CDA Net CPE",
            MARGIN, 50f, text(10f, MUTED),
        )
        c.save()
        c.translate(MARGIN, HEADER)
        // redundant links
        for (e in l.extra) {
            val a = l.byId[e.a] ?: continue
            val b = l.byId[e.b] ?: continue
            val x1 = a.x + a.w / 2; val y1 = a.y + a.h / 2; val x2 = b.x + b.w / 2; val y2 = b.y + b.h / 2
            val bend = -minOf(160f, kotlin.math.abs(x2 - x1) / 3 + 40f)
            val path = Path().apply { moveTo(x1, y1); cubicTo(x1, y1 + bend, x2, y2 + bend, x2, y2) }
            c.drawPath(path, stroke(if (e.kind == LinkKind.Wireless) WIRELESS else THIN, 1.6f, floatArrayOf(6f, 5f)))
            listOfNotNull(e.aPort, e.bPort).joinToString(" ↔ ").ifBlank { null }?.let { c.pill(it.take(26), (x1 + x2) / 2, (y1 + y2) / 2 + bend * 0.75f) }
        }
        // tree
        for ((parentId, link) in l.tree) {
            val p = l.byId[parentId] ?: continue
            val child = l.byId[if (link.a == parentId) link.b else link.a] ?: continue
            val paint = linkPaint(link.kind)
            val px = p.x + p.w / 2
            val top = p.y + p.h - 18f
            if (child.client) {
                val cy = child.y + 20f
                val cx = child.x + child.w / 2
                c.drawPath(Path().apply { moveTo(px, top); lineTo(px, cy); lineTo(cx, cy) }, paint)
                link.signalDbm?.let { c.pill("$it dBm", (px + cx) / 2, cy - 9, WIRELESS) }
            } else {
                val cx = child.x + child.w / 2
                val mid = child.y - 26f
                c.drawPath(Path().apply { moveTo(px, top); lineTo(px, mid); lineTo(cx, mid); lineTo(cx, child.y) }, paint)
                val label = portLabel(link, parentId)
                if (label.isNotBlank()) c.pill(label.take(24), cx, mid + 12)
                link.signalDbm?.let { c.pill("$it dBm", cx, mid - 10, WIRELESS) }
            }
        }
        // devices
        for (p in l.nodes) {
            val n = p.node
            val color = deviceColor(n.type).toArgb()
            val r = if (p.client) 21f else 29f
            val cx = p.x + p.w / 2
            val cy = p.y + r
            c.drawCircle(cx, cy, r, Paint(Paint.ANTI_ALIAS_FLAG).apply { this.color = 0xFFFFFFFF.toInt() })
            c.drawCircle(cx, cy, r, Paint(Paint.ANTI_ALIAS_FLAG).apply { this.color = color; alpha = 36 })
            c.drawCircle(cx, cy, r, stroke(color, 2f, if (n.ghost) floatArrayOf(4f, 3f) else null))
            ContextCompat.getDrawable(context, deviceIcon(n.type))?.mutate()?.let { d ->
                val s = if (p.client) 22 else 32
                d.setBounds((cx - s / 2).toInt(), (cy - s / 2).toInt(), (cx + s / 2).toInt(), (cy + s / 2).toInt())
                d.colorFilter = PorterDuffColorFilter(color, PorterDuff.Mode.SRC_IN)
                d.draw(c)
            }
            VendorBadges.of(n.vendor)?.let { b ->
                val tp = text(if (p.client) 6.5f else 7.5f, 0xFFFFFFFF.toInt(), bold = true)
                val tw = tp.measureText(b.short)
                val bx = cx + r * 0.45f
                val by = cy + r * 0.55f
                c.drawRoundRect(RectF(bx, by - 8, bx + tw + 6, by + 3), 3f, 3f, Paint(Paint.ANTI_ALIAS_FLAG).apply { this.color = b.color.toInt() })
                c.drawText(b.short, bx + 3, by + 0.5f, tp)
            }
            val labelY = p.y + 2 * r + 13f
            c.centered((if (n.isGateway) "★ " else "") + n.label, cx, labelY, p.w, text(if (p.client) 8.5f else 10.5f, bold = !p.client))
            if (!p.client) {
                val sub = listOfNotNull(if (n.ghost) "fuori scansione" else n.ip, if (p.hidden > 0) "+${p.hidden}" else null).joinToString(" · ")
                if (sub.isNotBlank()) c.centered(sub, cx, labelY + 12f, p.w, text(8.5f, MUTED))
            }
        }
        c.restore()
        // legend
        val ly = HEADER + l.height + 26f
        var x = MARGIN
        for ((k, label) in listOf(LinkKind.Lldp to "LLDP / CDP / MikroTik", LinkKind.Wireless to "wireless (segnale)", LinkKind.Fdb to "dalla tabella MAC", LinkKind.Assumed to "presunto")) {
            c.drawLine(x, ly, x + 24, ly, linkPaint(k))
            c.drawText(label, x + 30, ly + 4, text(9f, MUTED))
            x += 30 + text(9f).measureText(label) + 22
        }
        c.drawPath(Path().apply { moveTo(x, ly); cubicTo(x + 8, ly - 8, x + 16, ly - 8, x + 24, ly) }, stroke(THIN, 1.6f, floatArrayOf(6f, 5f)))
        c.drawText("ridondante", x + 30, ly + 4, text(9f, MUTED))
    }

    private fun portLabel(link: GraphLink, parentId: String): String {
        val parentPort = if (link.a == parentId) link.aPort else link.bPort
        val childPort = if (link.a == parentId) link.bPort else link.aPort
        return listOfNotNull(parentPort, childPort?.let { "→ $it" }).joinToString(" ")
    }
}
