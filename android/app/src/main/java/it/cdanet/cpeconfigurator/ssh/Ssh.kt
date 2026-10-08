package it.cdanet.cpeconfigurator.ssh

import com.jcraft.jsch.ChannelExec
import com.jcraft.jsch.JSch
import com.jcraft.jsch.Session
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.util.Properties

data class ExecResult(val exitCode: Int, val stdout: String, val stderr: String)

/**
 * Small JSch wrapper. Factory airOS (dropbear) and older RouterOS builds may only
 * offer legacy algorithms, so they are appended (not preferred) to the defaults.
 * Host keys are not pinned: see SECURITY.md for the residual risk.
 */
class SshConnection private constructor(private val session: Session) : AutoCloseable {

    fun exec(command: String, timeoutMs: Long = 10_000, stdin: ByteArray? = null): ExecResult {
        val ch = session.openChannel("exec") as ChannelExec
        val out = ByteArrayOutputStream()
        val err = ByteArrayOutputStream()
        ch.setCommand(command)
        ch.setOutputStream(out) // remote stdout -> out
        ch.setErrStream(err)
        // getOutputStream() is the remote stdin; closing it sends EOF.
        val remoteStdin = if (stdin != null) ch.getOutputStream() else null
        if (stdin == null) ch.setInputStream(null)
        ch.connect(5_000)
        try {
            if (remoteStdin != null && stdin != null) {
                remoteStdin.write(stdin)
                remoteStdin.flush()
                remoteStdin.close()
            }
            val deadline = System.currentTimeMillis() + timeoutMs
            while (!ch.isClosed) {
                if (System.currentTimeMillis() > deadline) throw IOException("Timeout comando SSH")
                Thread.sleep(50)
            }
            return ExecResult(ch.exitStatus, out.toString(Charsets.UTF_8.name()), err.toString(Charsets.UTF_8.name()))
        } finally {
            ch.disconnect()
        }
    }

    /** Fire-and-forget command whose connection is expected to drop (e.g. reboot). */
    fun execDetached(command: String) {
        runCatching {
            val ch = session.openChannel("exec") as ChannelExec
            ch.setCommand(command)
            ch.connect(3_000)
            Thread.sleep(500)
            ch.disconnect()
        }
    }

    override fun close() {
        runCatching { session.disconnect() }
    }

    companion object {
        private fun append(key: String, extra: String): String {
            val current: String? = JSch.getConfig(key)
            return if (current.isNullOrBlank()) extra else "$current,$extra"
        }

        fun connect(host: String, port: Int, username: String, password: String, timeoutMs: Int = 10_000): SshConnection {
            val jsch = JSch()
            val s = jsch.getSession(username, host, port)
            s.setPassword(password)
            val cfg = Properties()
            cfg["StrictHostKeyChecking"] = "no"
            cfg["PreferredAuthentications"] = "password,keyboard-interactive"
            cfg["server_host_key"] = append("server_host_key", "ssh-rsa,ssh-dss")
            cfg["PubkeyAcceptedAlgorithms"] = append("PubkeyAcceptedAlgorithms", "ssh-rsa")
            cfg["kex"] = append("kex", "diffie-hellman-group14-sha1,diffie-hellman-group1-sha1")
            cfg["cipher.c2s"] = append("cipher.c2s", "aes128-cbc,aes256-cbc,3des-cbc")
            cfg["cipher.s2c"] = append("cipher.s2c", "aes128-cbc,aes256-cbc,3des-cbc")
            cfg["mac.c2s"] = append("mac.c2s", "hmac-sha1")
            cfg["mac.s2c"] = append("mac.s2c", "hmac-sha1")
            s.setConfig(cfg)
            s.timeout = timeoutMs
            s.serverAliveInterval = 4_000
            try {
                s.connect(timeoutMs)
            } catch (e: Exception) {
                val msg = e.message.orEmpty()
                throw IOException(
                    when {
                        msg.contains("Auth fail", true) -> "Autenticazione SSH rifiutata (credenziali errate o primo avvio non completato)"
                        msg.contains("timeout", true) || msg.contains("timed out", true) -> "Timeout connessione SSH verso $host:$port"
                        msg.contains("refused", true) -> "Connessione SSH rifiutata da $host:$port"
                        else -> "SSH: $msg"
                    },
                    e,
                )
            }
            return SshConnection(s)
        }
    }
}
