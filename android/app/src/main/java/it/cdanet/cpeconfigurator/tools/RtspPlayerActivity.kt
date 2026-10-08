package it.cdanet.cpeconfigurator.tools

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.FrameLayout
import android.widget.TextView
import androidx.annotation.OptIn
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.rtsp.RtspMediaSource
import androidx.media3.ui.PlayerView

/** Full-screen RTSP viewer (Media3). Credentials travel only in the intent extras of this process. */
class RtspPlayerActivity : Activity() {
    private var player: ExoPlayer? = null

    @OptIn(UnstableApi::class)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        val view = PlayerView(this)
        root.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        val status = TextView(this).apply {
            setTextColor(Color.WHITE)
            setPadding(24, 24, 24, 24)
            text = intent.getStringExtra(EXTRA_LABEL).orEmpty()
        }
        root.addView(status, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.START))
        val close = Button(this).apply {
            text = "Chiudi"
            setOnClickListener { finish() }
        }
        root.addView(close, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.END))
        setContentView(root)

        val uri = Uri.parse(intent.getStringExtra(EXTRA_URI) ?: run { finish(); return })
        val p = ExoPlayer.Builder(this).build()
        player = p
        view.player = p
        val tcp = intent.getBooleanExtra(EXTRA_TCP, true)
        p.setMediaSource(RtspMediaSource.Factory().setForceUseRtpTcp(tcp).createMediaSource(MediaItem.fromUri(uri)))
        p.addListener(object : Player.Listener {
            override fun onPlayerError(error: PlaybackException) {
                status.text = "Errore stream: ${error.errorCodeName}"
            }
        })
        p.prepare()
        p.playWhenReady = true
    }

    override fun onStop() {
        super.onStop()
        player?.release()
        player = null
        finish()
    }

    companion object {
        private const val EXTRA_URI = "uri"
        private const val EXTRA_LABEL = "label"
        private const val EXTRA_TCP = "tcp"

        fun intent(context: Context, host: String, port: Int, path: String, username: String, password: String, tcp: Boolean = true): Intent {
            val auth = if (username.isNotBlank()) Uri.encode(username) + (if (password.isNotEmpty()) ":" + Uri.encode(password) else "") + "@" else ""
            val p = if (path.startsWith("/")) path else "/$path"
            return Intent(context, RtspPlayerActivity::class.java)
                .putExtra(EXTRA_URI, "rtsp://$auth$host:$port$p")
                .putExtra(EXTRA_LABEL, "rtsp://$host:$port$p")
                .putExtra(EXTRA_TCP, tcp)
        }
    }
}
