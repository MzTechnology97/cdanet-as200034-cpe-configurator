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

    fun wifiNetwork(): Network? = cm.allNetworksCompat().firstOrNull {
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
