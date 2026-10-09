package it.cdanet.cpeconfigurator.tools.topology

import it.cdanet.cpeconfigurator.network.Ip
import it.cdanet.cpeconfigurator.network.NetworkHelper
import it.cdanet.cpeconfigurator.tools.discovery.Found
import it.cdanet.cpeconfigurator.tools.discovery.VendorDiscovery
import it.cdanet.cpeconfigurator.tools.pro.Sadp
import it.cdanet.cpeconfigurator.tools.pro.ScanHost
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext

/** Result of "Costruisci mappa": the topology, the devices found by discovery and the enriched hosts. */
data class TopologyRun(val result: TopologyResult, val found: List<Found>, val hosts: List<ScanHost>)

/**
 * Local network map: multi-vendor discovery and SNMP (communities tried in order, `public` by
 * default) on the Wi-Fi network, then [Topology.build]. Everything stays on the phone.
 */
class TopologyScanner(private val network: NetworkHelper) {

    /** Device type from what a discovery protocol said (same wording as DeviceGuess). */
    fun kindOf(f: Found): String {
        val t = (f.details["Tipo"].orEmpty() + " " + f.vendor + " " + f.model.orEmpty()).lowercase()
        return when {
            f.protocol == "MNDP" -> "MikroTik ${f.model.orEmpty()}".trim()
            f.protocol == "SADP" || f.protocol == "Dahua" || f.protocol == "ONVIF" -> "Telecamera / NVR"
            f.protocol == "NSDP" -> "Switch / router Netgear"
            "internetgatewaydevice" in t || "wandevice" in t -> "Router / gateway"
            "printer" in t || "stampante" in t -> "Stampante"
            "mediarenderer" in t || "sonos" in t || "tv" in t -> "TV / multimedia"
            "google cast" in t -> "Chromecast / Google"
            "apple" in t || "airplay" in t -> "Apple (iPhone/iPad/Mac)"
            "qnap" in t || "synology" in t -> "NAS"
            "shelly" in t || "hue" in t || "esphome" in t -> "IoT / domotica"
            "camera" in t || "nvr" in t || "axis" in t -> "Telecamera / NVR"
            else -> ""
        }
    }

    /** Adds discovery names, vendors, MACs and types to the scanned hosts (and the hosts only discovery saw). */
    fun merge(hosts: List<ScanHost>, found: List<Found>): List<ScanHost> {
        val byIp = found.groupBy { it.ip }
        val known = hosts.map { it.ip }.toSet()
        val updated = hosts.map { h ->
            val fs = byIp[h.ip].orEmpty()
            if (fs.isEmpty()) h else h.copy(
                hostname = h.hostname ?: fs.firstNotNullOfOrNull { it.name },
                mac = h.mac ?: fs.firstNotNullOfOrNull { it.mac },
                vendor = h.vendor ?: fs.firstOrNull { it.vendor !in setOf("UPnP", "mDNS", "ONVIF") }?.vendor,
                kind = h.kind.ifBlank { fs.map { kindOf(it) }.firstOrNull { it.isNotBlank() }.orEmpty() },
            )
        }
        val extra = byIp.filterKeys { it !in known && Ip.parse(it) != null }.map { (ip, fs) ->
            ScanHost(ip, null, "discovery " + fs.joinToString("/") { it.protocol }, hostname = fs.firstNotNullOfOrNull { it.name }, mac = fs.firstNotNullOfOrNull { it.mac }, vendor = fs.first().vendor, kind = fs.map { kindOf(it) }.firstOrNull { it.isNotBlank() }.orEmpty())
        }
        return updated + extra
    }

    suspend fun run(hosts: List<ScanHost>, gatewayIp: String?, communities: List<String>, discovery: Boolean, progress: (String) -> Unit): TopologyRun =
        withContext(Dispatchers.IO) {
            network.onWifi {
                val lock = network.multicastLock()
                lock.acquire()
                try {
                    val found = if (!discovery) emptyList() else {
                        progress("Discovery multi-vendor (MikroTik, Hikvision, Dahua, ONVIF, UPnP, mDNS, Netgear)…")
                        val local = network.wifiLink()?.addresses?.map { it.substringBefore('/') }?.firstOrNull { Ip.parse(it) != null }
                        coroutineScope {
                            listOf(
                                async { runCatching { VendorDiscovery.mndp(3500) }.getOrDefault(emptyList()) },
                                async { runCatching { VendorDiscovery.dahua(3500) }.getOrDefault(emptyList()) },
                                async { runCatching { VendorDiscovery.onvif(3500) }.getOrDefault(emptyList()) },
                                async { runCatching { VendorDiscovery.ssdp(3500) }.getOrDefault(emptyList()) },
                                async { runCatching { VendorDiscovery.mdns(3500) }.getOrDefault(emptyList()) },
                                async { runCatching { VendorDiscovery.nsdp(3500) }.getOrDefault(emptyList()) },
                                async {
                                    runCatching { Sadp.discover(local, 3500) }.getOrDefault(emptyList()).map { d ->
                                        Found(d.ip, "SADP", "Hikvision", name = d.description.ifBlank { null }, model = d.model.ifBlank { null }, mac = d.mac.ifBlank { null }, firmware = d.firmware.ifBlank { null })
                                    }
                                },
                            ).awaitAll().flatten()
                        }
                    }
                    val merged = merge(hosts, found)
                    val devices = if (communities.isEmpty()) emptyList() else {
                        progress("SNMP su ${merged.size} host (community: ${communities.joinToString(", ")})…")
                        val gate = Semaphore(24)
                        val responders = coroutineScope {
                            merged.map { h -> async { gate.withPermit { Topology.probe(h.ip, communities)?.let { h.ip to it } } } }.awaitAll().filterNotNull()
                        }
                        progress("Lettura di ${responders.size} apparati SNMP (LLDP/CDP, tabelle MAC, ARP)…")
                        val slow = Semaphore(4)
                        coroutineScope {
                            responders.map { (ip, r) ->
                                async {
                                    slow.withPermit {
                                        val (community, sys) = r
                                        Topology.collect(ip, community, sys["1.3.6.1.2.1.1.5.0"].orEmpty(), sys["1.3.6.1.2.1.1.1.0"].orEmpty())
                                    }
                                }
                            }.awaitAll()
                        }
                    }
                    progress("Costruzione della mappa…")
                    TopologyRun(Topology.build(merged, devices, gatewayIp), found, merged)
                } finally {
                    lock.release()
                }
            }
        }
}
