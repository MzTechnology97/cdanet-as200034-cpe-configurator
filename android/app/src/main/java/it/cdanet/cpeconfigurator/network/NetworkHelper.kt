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
    /** "Wi-Fi", "Ethernet" (cable, USB-C adapter), "Cellulare", "VPN", "Rete". */
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
) {
    val isCable: Boolean get() = transport == "Ethernet"
}

/**
 * Network selection. When the phone joins the CPE management Wi-Fi (no Internet), or a cable
 * through a USB-C Ethernet adapter, while mobile data is on, Android keeps cellular as the default
 * network: local operations must therefore be explicitly bound to that local network.
 */
/** airOS management Wi-Fi: «<model>:<end of the MAC>», e.g. «Loco5AC:1C6A1BCA95C3», «LBE-5AC-Gen2:A1B2C3». */
internal fun isCpeSsid(ssid: String?): Boolean = ssid != null && Regex("^[A-Za-z0-9._ -]+:[0-9A-Fa-f]{6,12}$").matches(ssid.trim('"'))

class NetworkHelper(context: Context) {
    private val cm = context.getSystemService(ConnectivityManager::class.java)
    private val wifi = context.applicationContext.getSystemService(WifiManager::class.java)
    private val bindMutex = Mutex()

    /**
     * True while the phone is on a local network: a Wi-Fi or a cable (USB-C Ethernet adapter), with
     * or without Internet.
     */
    private val _localConnected = kotlinx.coroutines.flow.MutableStateFlow(false)
    val localConnected: kotlinx.coroutines.flow.StateFlow<Boolean> = _localConnected

    /**
     * True while some network of the phone reaches Internet (validated). Back to true after a roof
     * without signal or the customer's line coming up: the queues are sent at once.
     */
    private val _internet = kotlinx.coroutines.flow.MutableStateFlow(false)
    val internet: kotlinx.coroutines.flow.StateFlow<Boolean> = _internet

    init {
        runCatching {
            _internet.value = !noInternet()
            cm.registerNetworkCallback(
                android.net.NetworkRequest.Builder().addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).build(),
                object : ConnectivityManager.NetworkCallback() {
                    override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) { _internet.value = !noInternet() }
                    override fun onLost(network: Network) { _internet.value = cm.allNetworksCompat().any { it != network && reachesInternet(it) } }
                },
            )
        }
    }

    init {
        _localConnected.value = localNetwork() != null
        // Wi-Fi and cable alike: a USB-C Ethernet adapter plugged in unlocks the same screens
        listOf(NetworkCapabilities.TRANSPORT_WIFI, NetworkCapabilities.TRANSPORT_ETHERNET).forEach { transport ->
            runCatching {
                cm.registerNetworkCallback(
                    android.net.NetworkRequest.Builder().addTransportType(transport)
                        // an Ethernet without Internet (the CPE, a LAN) is a network all the same
                        .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                        .build(),
                    object : ConnectivityManager.NetworkCallback() {
                        override fun onAvailable(network: Network) { _localConnected.value = true }
                        override fun onLinkPropertiesChanged(network: Network, lp: LinkProperties) { _localConnected.value = localNetwork() != null }
                        // the lost network can still be listed while this runs: left out explicitly
                        override fun onLost(network: Network) { _localConnected.value = localNetwork(except = network) != null }
                    },
                )
            }
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
                _localConnected.value = true
            }
            override fun onUnavailable() {
                cpeCallback = null
                _cpeWifi.value = CpeWifi.NotFound
            }
            override fun onLost(network: Network) {
                if (network == cpeNet) cpeNet = null
                _cpeWifi.value = CpeWifi.Lost
                _localConnected.value = localNetwork(except = network) != null
            }
        }
        cpeCallback = cb
        _cpeWifi.value = CpeWifi.Searching
        runCatching { cm.requestNetwork(request, cb) }.onFailure {
            cpeCallback = null
            _cpeWifi.value = CpeWifi.NotFound
        }
    }

    /** A failed attempt's message belongs to the screen it was made on: back to idle when that screen goes. */
    fun clearCpeWifiResult() {
        if (_cpeWifi.value == CpeWifi.NotFound) _cpeWifi.value = CpeWifi.Idle
    }

    /** Leaves the CPE's Wi-Fi joined from the app (and stops asking for it). */
    fun leaveCpeWifi() {
        cpeCallback?.let { runCatching { cm.unregisterNetworkCallback(it) } }
        cpeCallback = null
        cpeNet = null
        if (_cpeWifi.value != CpeWifi.Idle) _cpeWifi.value = CpeWifi.Idle
        _localConnected.value = localNetwork() != null
    }

    /**
     * The local network the CPE steps and the network tools use: the CPE's Wi-Fi joined from the
     * app first, then a cable (USB-C Ethernet adapter, plugged in on purpose), then the phone's Wi-Fi.
     */
    fun localNetwork(except: Network? = null): Network? =
        cpeNet?.takeIf { it != except && cm.getNetworkCapabilities(it) != null } ?: ethernetNetwork(except) ?: wifiNetwork(except)

    /** The phone's Wi-Fi only (the Wi-Fi Analyzer, the CPE's Wi-Fi joined from the app first). */
    fun wifiNetwork(except: Network? = null): Network? = cpeNet?.takeIf { it != except && cm.getNetworkCapabilities(it) != null } ?: cm.allNetworksCompat().firstOrNull {
        it != except && cm.getNetworkCapabilities(it)?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true
    }

    /** A cable through a USB-C Ethernet adapter (or a dock), with or without Internet. */
    fun ethernetNetwork(except: Network? = null): Network? = cm.allNetworksCompat().firstOrNull {
        it != except && cm.getNetworkCapabilities(it)?.let { c -> c.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) && !c.hasTransport(NetworkCapabilities.TRANSPORT_VPN) } == true
    }

    /**
     * The cable is in but the phone got no IPv4 address: nothing on the other end gives one (a CPE
     * still at its factory settings has no DHCP server). Android does not let an app set a static
     * address, so the CPE is reached on its Wi-Fi instead, or behind a router.
     */
    fun ethernetWithoutAddress(): Boolean = ethernetNetwork()?.let { n ->
        cm.getLinkProperties(n)?.linkAddresses?.none { it.address is Inet4Address } ?: true
    } == true

    @Suppress("DEPRECATION")
    private fun ConnectivityManager.allNetworksCompat(): List<Network> = allNetworks.toList()

    /** Runs [block] with the whole process bound to the local network (sockets, DNS, WebView). */
    suspend fun <T> onLocal(block: suspend () -> T): T = bindMutex.withLock {
        val net = localNetwork() ?: throw IllegalStateException(
            if (ethernetWithoutAddress()) NO_CABLE_ADDRESS else "Nessuna rete locale: collegati alla Wi-Fi o con il cavo (adattatore USB-C Ethernet)",
        )
        val previous = cm.boundNetworkForProcess
        cm.bindProcessToNetwork(net)
        try {
            block()
        } finally {
            cm.bindProcessToNetwork(previous)
        }
    }

    fun bindToLocal(): Boolean = localNetwork()?.let { cm.bindProcessToNetwork(it) } ?: false

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

    /** The local network as the screens show it (Wi-Fi or cable). */
    fun localLink(): LinkInfo? = localNetwork()?.let { describe(it) }

    /** The phone's Wi-Fi only (the Wi-Fi Analyzer). */
    fun wifiLink(): LinkInfo? = wifiNetwork()?.let { describe(it) }

    /**
     * The customer's router for the speed test: a cable to one of its LAN ports first (the most
     * faithful measure, no radio of the phone in the way), else a Wi-Fi the phone joined itself
     * (never the CPE's one joined from the app, never mobile data). Null when neither is there.
     */
    fun routerLink(): Pair<Network, LinkInfo>? =
        ethernetNetwork()?.let { it to describe(it) }?.takeIf { it.second.addresses.any { a -> a.contains('.') } }
            ?: cm.allNetworksCompat().filter {
                it != cpeNet && cm.getNetworkCapabilities(it)?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true
            }.map { it to describe(it) }.firstOrNull { !isCpeSsid(it.second.wifiSsid) }

    /** The phone is on a CPE's management Wi-Fi joined from the settings (not from the app). */
    fun onCpeSsid(): Boolean = cm.allNetworksCompat().any {
        cm.getNetworkCapabilities(it)?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true && isCpeSsid(describe(it).wifiSsid)
    }

    /** True while [net] is still one of the phone's networks (a released one makes sockets fail with EPERM). */
    fun isAlive(net: Network?): Boolean = net != null && cm.getNetworkCapabilities(net) != null

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
        // IPv4 first: a link-local IPv6 router (fe80::…) is listed too on some Wi-Fi, never the CPE
        val defaults = lp?.routes?.filter { it.isDefaultRoute && it.gateway != null }.orEmpty()
        val gateway = (defaults.firstOrNull { it.gateway is java.net.Inet4Address } ?: defaults.firstOrNull())?.gateway?.hostAddress
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

    companion object {
        const val NO_CABLE_ADDRESS = "Cavo collegato ma il telefono non ha ricevuto un indirizzo: dall'altra parte nessuno lo assegna (una CPE di fabbrica non ha DHCP). Usa la Wi-Fi della CPE, oppure collega il cavo a un router o a una CPE già configurata con il DHCP."
    }
}
