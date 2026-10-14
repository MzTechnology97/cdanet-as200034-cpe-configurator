package it.cdanet.cpeconfigurator.network

import android.annotation.SuppressLint
import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.wifi.WifiInfo
import android.net.wifi.WifiManager
import android.os.Build
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.net.Inet4Address

data class LinkInfo(
    val transport: String,
    val interfaceName: String?,
    val addresses: List<String>,
    val cidr: String?,
    val gateway: String?,
    val dns: List<String>,
    val validated: Boolean,
    val wifiSsid: String?,
    val wifiBssid: String?,
    val wifiRssi: Int?,
    val wifiFrequency: Int?,
    val linkSpeedMbps: Int?,
)

/**
 * Network selection. When the phone joins the CPE management Wi-Fi (no Internet)
 * while mobile data is on, Android keeps cellular as the default network: local
 * operations must therefore be explicitly bound to the Wi-Fi network.
 */
class NetworkHelper(context: Context) {
    private val cm = context.getSystemService(ConnectivityManager::class.java)
    private val wifi = context.applicationContext.getSystemService(WifiManager::class.java)
    private val bindMutex = Mutex()

    /** True while the phone is connected to a Wi-Fi network (with or without Internet). */
    private val _wifiConnected = kotlinx.coroutines.flow.MutableStateFlow(false)
    val wifiConnected: kotlinx.coroutines.flow.StateFlow<Boolean> = _wifiConnected

    init {
        _wifiConnected.value = wifiNetwork() != null
        runCatching {
            cm.registerNetworkCallback(
                android.net.NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI).build(),
                object : ConnectivityManager.NetworkCallback() {
                    override fun onAvailable(network: Network) { _wifiConnected.value = true }
                    override fun onLost(network: Network) { _wifiConnected.value = wifiNetwork() != null }
                },
            )
        }
    }

    val wifiEnabled: Boolean get() = runCatching { wifi.isWifiEnabled }.getOrDefault(false)

    /** The CPE's management Wi-Fi joined from the app: only this app uses it, the phone keeps its Internet. */
    enum class CpeWifi { Idle, Searching, Connected, NotFound, Lost }

    private val _cpeWifi = kotlinx.coroutines.flow.MutableStateFlow(CpeWifi.Idle)
    val cpeWifi: kotlinx.coroutines.flow.StateFlow<CpeWifi> = _cpeWifi

    @Volatile private var cpeNet: Network? = null
    private var cpeCallback: ConnectivityManager.NetworkCallback? = null

    /** Android 10+: the system lists the CPE Wi-Fi networks nearby and the installer picks one. */
    val canJoinCpe: Boolean get() = android.os.Build.VERSION.SDK_INT >= 29

    /**
     * Joins the management Wi-Fi of a CPE (open, named like «LBE-5AC-Gen2:A1B2C3») without leaving
     * the phone's settings: Android shows the nearby ones, the installer taps it. The network is the
     * app's own: sockets of the CPE steps go there, the server is still reached on mobile data.
     */
    fun joinCpeWifi() {
        if (android.os.Build.VERSION.SDK_INT < 29) return
        leaveCpeWifi()
        val spec = android.net.wifi.WifiNetworkSpecifier.Builder()
            // airOS management networks are "<model>:<end of the MAC>"; a home Wi-Fi rarely has a colon
            .setSsidPattern(android.os.PatternMatcher(".*:.*", android.os.PatternMatcher.PATTERN_SIMPLE_GLOB))
            .build()
        val request = android.net.NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .setNetworkSpecifier(spec)
            .build()
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                cpeNet = network
                _cpeWifi.value = CpeWifi.Connected
                _wifiConnected.value = true
            }
            override fun onUnavailable() {
                cpeCallback = null
                _cpeWifi.value = CpeWifi.NotFound
            }
            override fun onLost(network: Network) {
                if (network == cpeNet) cpeNet = null
                _cpeWifi.value = CpeWifi.Lost
                _wifiConnected.value = wifiNetwork() != null
            }
        }
        cpeCallback = cb
        _cpeWifi.value = CpeWifi.Searching
        runCatching { cm.requestNetwork(request, cb) }.onFailure {
            cpeCallback = null
            _cpeWifi.value = CpeWifi.NotFound
        }
    }

    /** Leaves the CPE's Wi-Fi joined from the app (and stops asking for it). */
    fun leaveCpeWifi() {
        cpeCallback?.let { runCatching { cm.unregisterNetworkCallback(it) } }
        cpeCallback = null
        cpeNet = null
        if (_cpeWifi.value != CpeWifi.Idle) _cpeWifi.value = CpeWifi.Idle
        _wifiConnected.value = wifiNetwork() != null
    }

    /** The Wi-Fi the CPE steps use: the CPE's one joined from the app first, else the phone's Wi-Fi. */
    fun wifiNetwork(): Network? = cpeNet?.takeIf { cm.getNetworkCapabilities(it) != null } ?: cm.allNetworksCompat().firstOrNull {
        cm.getNetworkCapabilities(it)?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true
    }

    @Suppress("DEPRECATION")
    private fun ConnectivityManager.allNetworksCompat(): List<Network> = allNetworks.toList()

    /** Runs [block] with the whole process bound to Wi-Fi (sockets, DNS, WebView). */
    suspend fun <T> onWifi(block: suspend () -> T): T = bindMutex.withLock {
        val net = wifiNetwork() ?: throw IllegalStateException("Nessuna rete Wi-Fi collegata")
        val previous = cm.boundNetworkForProcess
        cm.bindProcessToNetwork(net)
        try {
            block()
        } finally {
            cm.bindProcessToNetwork(previous)
        }
    }

    fun bindToWifi(): Boolean = wifiNetwork()?.let { cm.bindProcessToNetwork(it) } ?: false

    fun unbind() {
        cm.bindProcessToNetwork(null)
    }

    private fun reachesInternet(n: Network?): Boolean =
        n != null && cm.getNetworkCapabilities(n)?.let {
            it.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) && it.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
        } == true

    /**
     * The network to reach our server through when the default one would not: the process bound
     * to the CPE's Wi-Fi, or the phone on a Wi-Fi without Internet, while mobile data (or another
     * network) has it. Null when the default network already reaches Internet, or none does.
     */
    fun internetNetwork(): Network? {
        if (cm.boundNetworkForProcess == null && reachesInternet(cm.activeNetwork)) return null
        return cm.allNetworksCompat().firstOrNull { reachesInternet(it) }
    }

    /** True when no network of the phone reaches Internet (e.g. only the CPE's Wi-Fi, mobile data off). */
    fun noInternet(): Boolean = cm.allNetworksCompat().none { reachesInternet(it) }

    fun isOnline(): Boolean {
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    }

    fun wifiLink(): LinkInfo? = wifiNetwork()?.let { describe(it) }

    fun activeLink(): LinkInfo? = cm.activeNetwork?.let { describe(it) }

    @SuppressLint("MissingPermission")
    private fun describe(net: Network): LinkInfo {
        val lp: LinkProperties? = cm.getLinkProperties(net)
        val caps = cm.getNetworkCapabilities(net)
        val isWifi = caps?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true
        var cidr: String? = null
        val addresses = lp?.linkAddresses?.map { it.toString() }.orEmpty()
        lp?.linkAddresses?.firstOrNull { it.address is Inet4Address }?.let { la ->
            val ip = Ip.parse(la.address.hostAddress ?: "") ?: return@let
            val c = Ip.Cidr(ip and Ip.parseCidr("0.0.0.0/${la.prefixLength}").mask, la.prefixLength)
            cidr = c.toString()
        }
        val gateway = lp?.routes?.firstOrNull { it.isDefaultRoute && it.gateway != null }?.gateway?.hostAddress
        val info: WifiInfo? = if (isWifi) wifiInfo(caps) else null
        return LinkInfo(
            transport = when {
                isWifi -> "Wi-Fi"
                caps?.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) == true -> "Cellulare"
                caps?.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) == true -> "Ethernet"
                caps?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true -> "VPN"
                else -> "Rete"
            },
            interfaceName = lp?.interfaceName,
            addresses = addresses,
            cidr = cidr,
            gateway = gateway,
            dns = lp?.dnsServers?.mapNotNull { it.hostAddress }.orEmpty(),
            validated = caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true,
            wifiSsid = info?.ssid?.trim('"')?.takeUnless { it == WifiManager.UNKNOWN_SSID.trim('"') || it.isBlank() },
            wifiBssid = info?.bssid?.takeUnless { it == "02:00:00:00:00:00" },
            wifiRssi = info?.rssi,
            wifiFrequency = info?.frequency,
            linkSpeedMbps = info?.linkSpeed,
        )
    }

    // NetworkCapabilities.transportInfo redacts the SSID on Android 12+ unless the
    // callback opts into location info; the legacy accessor still honours the permission.
    @Suppress("DEPRECATION", "UNUSED_PARAMETER")
    private fun wifiInfo(caps: NetworkCapabilities?): WifiInfo? = wifi.connectionInfo

    fun multicastLock(): WifiManager.MulticastLock = wifi.createMulticastLock("cda-discovery").apply { setReferenceCounted(false) }

    val wifiManager: WifiManager get() = wifi
}
