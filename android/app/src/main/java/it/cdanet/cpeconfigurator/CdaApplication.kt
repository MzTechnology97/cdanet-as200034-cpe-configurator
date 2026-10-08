package it.cdanet.cpeconfigurator

import android.app.Application
import it.cdanet.cpeconfigurator.core.AppContainer

class CdaApplication : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
    }
}
