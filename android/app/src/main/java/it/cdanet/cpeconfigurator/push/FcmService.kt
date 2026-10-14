package it.cdanet.cpeconfigurator.push

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import it.cdanet.cpeconfigurator.alerts.PhoneAlerts
import kotlinx.coroutines.runBlocking

/**
 * Firebase wakes the app for every notification (data only, high priority): the app reads its
 * notifications like the 15-minute check and shows them; when the server cannot be read right
 * now, the message itself is shown.
 */
class FcmService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        val shown = runCatching { runBlocking { PhoneAlerts.check(applicationContext) } }.getOrDefault(false)
        if (!shown) {
            val title = message.data["title"] ?: return
            PhoneAlerts.notify(applicationContext, (System.currentTimeMillis() % 100_000).toInt() + 200_000, title, message.data["body"].orEmpty())
        }
    }

    override fun onNewToken(token: String) {
        runBlocking { Push.register(applicationContext, token) }
    }
}
