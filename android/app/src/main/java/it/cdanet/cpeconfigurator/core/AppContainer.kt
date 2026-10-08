package it.cdanet.cpeconfigurator.core

import android.content.Context
import it.cdanet.cpeconfigurator.BuildConfig
import it.cdanet.cpeconfigurator.data.ApiClient
import it.cdanet.cpeconfigurator.data.ResultQueue
import it.cdanet.cpeconfigurator.data.Session
import it.cdanet.cpeconfigurator.data.Settings
import it.cdanet.cpeconfigurator.field.FieldController
import it.cdanet.cpeconfigurator.network.NetworkHelper
import it.cdanet.cpeconfigurator.provisioning.ProvisioningController
import it.cdanet.cpeconfigurator.routeros.RouterOsClient
import it.cdanet.cpeconfigurator.tools.LocalTools
import it.cdanet.cpeconfigurator.update.AppUpdater
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

/** Process-wide singletons. Secrets held here live only in process memory. */
class AppContainer(context: Context) {
    val appContext: Context = context.applicationContext
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    val settings = Settings(appContext)
    val session = Session()
    val api = ApiClient(settings, session, clientHeader = "android/${BuildConfig.VERSION_NAME.removeSuffix("-debug")}")
    val network = NetworkHelper(appContext)
    val resultQueue = ResultQueue(appContext, api, session, scope)
    val provisioning = ProvisioningController(api, network, resultQueue, scope)
    val routerOs = RouterOsClient(api, network)
    val tools = LocalTools(network, api, session)
    val field = FieldController(api, network, scope)

    /** AP selected in Copertura for the compass. */
    val compassTarget = kotlinx.coroutines.flow.MutableStateFlow<it.cdanet.cpeconfigurator.field.CompassTarget?>(null)

    /** Job opened from the history (or just provisioned) for acceptance test / replacement. */
    val selectedJob = kotlinx.coroutines.flow.MutableStateFlow<it.cdanet.cpeconfigurator.data.JobDto?>(null)
    val updater = AppUpdater(appContext, settings)
}
