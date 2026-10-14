package it.cdanet.cpeconfigurator

import android.app.Application
import it.cdanet.cpeconfigurator.core.AppContainer

class CdaApplication : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
        // push notifications: Firebase ready before a message wakes the app (when the server has it)
        it.cdanet.cpeconfigurator.push.Push.initAtStart(this)
    }
}
