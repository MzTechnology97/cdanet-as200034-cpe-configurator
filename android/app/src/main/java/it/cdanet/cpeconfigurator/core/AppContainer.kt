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
import kotlinx.coroutines.launch
import it.cdanet.cpeconfigurator.network.TestTls

/** Process-wide singletons. Secrets held here live only in process memory. */
class AppContainer(context: Context) {
    val appContext: Context = context.applicationContext
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    val settings = Settings(appContext)
    val session = Session()
    val network = NetworkHelper(appContext)
    val api = ApiClient(settings, session, clientHeader = "android/${BuildConfig.VERSION_NAME.removeSuffix("-debug")}", network = network)
    val resultQueue = ResultQueue(appContext, api, session, scope)
    /** Secrets for field work without Internet (prepared configuration, CPE credentials), encrypted. */
    val secure = it.cdanet.cpeconfigurator.security.SecureStore(appContext)
    val provisioning = ProvisioningController(api, network, resultQueue, scope, secure)
    val routerOs = RouterOsClient(api, network)
    val tools = LocalTools(network, api, session)
    val field = FieldController(api, network, scope, secure)
    val firmware = it.cdanet.cpeconfigurator.firmware.FirmwareStore(appContext)
    val pointingCache = it.cdanet.cpeconfigurator.data.PointingCache(appContext)
    val install = it.cdanet.cpeconfigurator.install.InstallController(api, field, pointingCache, session)
    val quickLogin = it.cdanet.cpeconfigurator.security.QuickLogin(appContext)

    /** Set after a login with the password: the app then offers the fingerprint/face quick login. */
    val offerQuickLogin = kotlinx.coroutines.flow.MutableStateFlow(false)

    /** "Sblocco a ogni apertura": the app came back after a while, fingerprint/face needed. */
    val locked = kotlinx.coroutines.flow.MutableStateFlow(false)

    /** Pull to refresh: each pull bumps it, the screens with data load again. */
    val refresh = kotlinx.coroutines.flow.MutableStateFlow(0)

    /** Work order started from Oggi: the acceptance test checks the GPS against its position. */
    val activeWorkOrder = kotlinx.coroutines.flow.MutableStateFlow<it.cdanet.cpeconfigurator.data.WorkOrderDto?>(null)
    @Volatile var backgroundSince = 0L
    val acceptanceQueue = it.cdanet.cpeconfigurator.field.AcceptanceQueue(appContext, api, session, resultQueue, scope)

    init {
        // test option "unverified server certificate": kept in sync for every client of our server
        scope.launch { settings.insecureTls.collect { TestTls.enabled = it } }
    }

    /** Optional features enabled by the admin (from /api/meta at login). Empty = all on (offline). */
    val modules = kotlinx.coroutines.flow.MutableStateFlow<Map<String, Boolean>>(emptyMap())
    fun moduleOn(key: String): Boolean = modules.value[key] != false

    private val screenPrefs = appContext.getSharedPreferences("screen", Context.MODE_PRIVATE)

    /**
     * Screenshots and screen recording blocked for this account (owner and NOC, 14/10/2026: only
     * admins, and the installers enabled one by one). The last answer stays on the phone, so the
     * block holds offline and from the very first frame.
     */
    /** «Nuovo intervento» from Oggi (NOC): the calendar opens with the editor. */
    var calendarNewOrder = false

    // blocked by default: a new install, a logged-out app or an account still being checked never
    // gets the screenshots of the previous account (an admin who logged out, owner 15/10/2026)
    val secureScreen = kotlinx.coroutines.flow.MutableStateFlow(screenPrefs.getBoolean("secure", true))

    /** Title of the screen on show (for the NOC's notice of a screenshot attempt). */
    val currentScreen = kotlinx.coroutines.flow.MutableStateFlow("")

    /**
     * Decides it from the account: admins never blocked; the others blocked unless the server says
     * their «Screenshot nell'app» is on. [modules] null = not known yet (login, offline): blocked.
     */
    fun updateSecureScreen(role: String?, modules: Map<String, Boolean>?) {
        setSecureScreen(SecureScreen.blocked(role, modules))
    }

    /** Logged out (or the session expired): blocked until the next account is known. */
    fun lockScreenCapture() = setSecureScreen(true)

    private fun setSecureScreen(secure: Boolean) {
        secureScreen.value = secure
        runCatching { screenPrefs.edit().putBoolean("secure", secure).apply() }
    }

    /** Host chosen in the IP scanner for the port scanner. */
    val portScanTarget = kotlinx.coroutines.flow.MutableStateFlow<String?>(null)

    /** Admin "Gestione CPE": the UISP device to show, and a request to open the screen. */
    val adminCpeId = kotlinx.coroutines.flow.MutableStateFlow<String?>(null)
    val openAdminCpe = kotlinx.coroutines.flow.MutableSharedFlow<Unit>(extraBufferCapacity = 1)

    /** AP selected in Copertura for the compass. */
    val compassTarget = kotlinx.coroutines.flow.MutableStateFlow<it.cdanet.cpeconfigurator.field.CompassTarget?>(null)

    /** Job opened from the history (or just provisioned) for acceptance test / replacement. */
    val selectedJob = kotlinx.coroutines.flow.MutableStateFlow<it.cdanet.cpeconfigurator.data.JobDto?>(null)
    val updater = AppUpdater(appContext, settings)
}
