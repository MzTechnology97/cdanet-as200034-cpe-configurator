package it.cdanet.cpeconfigurator.tools.topology

import it.cdanet.cpeconfigurator.network.Ip
import it.cdanet.cpeconfigurator.network.NetworkHelper
import it.cdanet.cpeconfigurator.tools.discovery.Fingerprint
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
data class TopologyRun(val result: TopologyResult, val found: List<Found>, val hosts: List<ScanHost>, val devices: List<SnmpDevice> = emptyList())

/**
 * Local network map: multi-vendor discovery and SNMP (communities tried in order, `public` by
 * default) on the Wi-Fi network, then the graph ([TopoGraph]). Everything stays on the phone.
 */
class TopologyScanner(private val network: NetworkHelper) {

    /** Device type from what a discovery protocol said (same wording as DeviceGuess). */
    fun kindOf(f: Found): String {
        val t = (f.details["Tipo"].orEmpty() + " " + f.vendor + " " + f.model.orEmpty()).lowercase()
        return when {
            f.protocol == "MNDP" -> "MikroTik ${f.model.orEmpty()}".trim()
            f.protocol == "SADP" || f.protocol == "Dahua" || f.protocol == "ONVIF" -> "Telecamera / NVR"
            f.protocol == "NSDP" -> "Switch / router Netgear"
            f.protocol == "WSD" -> f.details["Tipo"].orEmpty()
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

    /** The protocols of [discover], in display order. */
    val protocols = listOf("MNDP", "Ubiquiti", "SADP", "Dahua", "ONVIF", "WSD", "SSDP", "mDNS", "NSDP")

    /** Vendor protocols in parallel (~3.5 s), each reported to [onDone] with its answers when it ends. */
    private suspend fun vendorDiscovery(local: String?, onDone: (String, Int) -> Unit = { _, _ -> }): List<Found> = coroutineScope {
        fun go(name: String, block: suspend () -> List<Found>) = async { runCatching { block() }.getOrDefault(emptyList()).also { onDone(name, it.size) } }
        listOf(
            go("MNDP") { VendorDiscovery.mndp(3500) },
            go("Dahua") { VendorDiscovery.dahua(3500) },
            go("ONVIF") { VendorDiscovery.onvif(3500) },
            go("WSD") { VendorDiscovery.wsd(3500) },
            go("SSDP") { VendorDiscovery.ssdp(3500) },
            go("mDNS") { VendorDiscovery.mdns(3500) },
            go("NSDP") { VendorDiscovery.nsdp(3500) },
            go("SADP") {
                Sadp.discover(local, 3500).map { d ->
                    Found(d.ip, "SADP", "Hikvision", name = d.description.ifBlank { null }, model = d.model.ifBlank { null }, mac = d.mac.ifBlank { null }, firmware = d.firmware.ifBlank { null })
                }
            },
        ).awaitAll().flatten()
    }

    /**
     * Discovery only (the Discovery tab): every vendor protocol plus Ubiquiti on the Wi-Fi network;
     * [onDone] gets each protocol when it ends, with the number of answers.
     */
    suspend fun discover(onDone: (String, Int) -> Unit = { _, _ -> }): List<Found> = coroutineScope {
        val ubnt = async(Dispatchers.IO) {
            runCatching { it.cdanet.cpeconfigurator.tools.UbntDiscovery.discover(network, 3500) }.getOrDefault(emptyList()).mapNotNull { d ->
                d.ip?.let { ip ->
                    Found(
                        ip, "Ubiquiti", "Ubiquiti", name = d.hostname, model = d.fullModel ?: d.model, mac = d.mac, firmware = d.firmware,
                        details = listOfNotNull(d.ssid?.let { "SSID" to it }, d.uptimeSec?.let { "Uptime" to "${it / 86400} g ${it % 86400 / 3600} h" }).toMap(),
                    )
                }
            }.also { onDone("Ubiquiti", it.size) }
        }
        val rest = withContext(Dispatchers.IO) {
            network.onWifi {
                val lock = network.multicastLock()
                lock.acquire()
                try {
                    vendorDiscovery(network.wifiLink()?.addresses?.map { it.substringBefore('/') }?.firstOrNull { Ip.parse(it) != null }, onDone)
                } finally {
                    lock.release()
                }
            }
        }
        rest + ubnt.await()
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
                vendor = h.vendor ?: fs.firstOrNull { it.vendor !in setOf("UPnP", "mDNS", "ONVIF", "WS-Discovery") }?.vendor,
                kind = h.kind.ifBlank { fs.map { kindOf(it) }.firstOrNull { it.isNotBlank() }.orEmpty() },
            )
        }
        val extra = byIp.filterKeys { it !in known && Ip.parse(it) != null }.map { (ip, fs) ->
            ScanHost(ip, null, "discovery " + fs.joinToString("/") { it.protocol }, hostname = fs.firstNotNullOfOrNull { it.name }, mac = fs.firstNotNullOfOrNull { it.mac }, vendor = fs.first().vendor, kind = fs.map { kindOf(it) }.firstOrNull { it.isNotBlank() }.orEmpty())
        }
        return updated + extra
    }

    /**
     * Discovery, SNMP and fingerprints on the Wi-Fi network, then the graph. [vendorOf] resolves MAC
     * vendors (IEEE registry, through the server) for the MACs learned from the routers' ARP tables.
     */
    suspend fun run(
        hosts: List<ScanHost>,
        gatewayIp: String?,
        communities: List<String>,
        discovery: Boolean,
        fingerprints: Boolean = true,
        vendorOf: suspend (List<String>) -> Map<String, String> = { emptyMap() },
        progress: (String) -> Unit,
    ): TopologyRun {
        val (found, merged, devices, prints) = withContext(Dispatchers.IO) {
            network.onWifi {
                val lock = network.multicastLock()
                lock.acquire()
                try {
                    val local = network.wifiLink()?.addresses?.map { it.substringBefore('/') }?.firstOrNull { Ip.parse(it) != null }
                    val found = if (!discovery) emptyList() else {
                        progress("Discovery multi-vendor (MikroTik, Ubiquiti, Hikvision, Dahua, ONVIF, WS-Discovery, UPnP, mDNS, Netgear)…")
                        vendorDiscovery(local)
                    }
                    var merged = merge(hosts, found)
                    val devices = if (communities.isEmpty()) emptyList() else {
                        progress("SNMP su ${merged.size} host (community: ${communities.joinToString(", ")})…")
                        val gate = Semaphore(24)
                        val responders = coroutineScope {
                            merged.map { h -> async { gate.withPermit { Topology.probe(h.ip, communities)?.let { h.ip to it } } } }.awaitAll().filterNotNull()
                        }
                        progress("Lettura di ${responders.size} apparati SNMP (LLDP, CDP, vicini MikroTik, stazioni Ubiquiti, tabelle MAC, ARP)…")
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
                    // MACs the phone could not read (Android hides the ARP table): from the routers' ARP tables
                    val arp = devices.flatMap { it.arp.entries }.associate { it.key to it.value.uppercase() }
                    merged = merged.map { h -> if (h.mac == null && arp[h.ip] != null) h.copy(mac = arp[h.ip]) else h }
                    val prints = if (!fingerprints) emptyMap() else {
                        progress("Impronte dei servizi (web, SSH, RTSP, SIP) su ${merged.size} host…")
                        val gate = Semaphore(12)
                        coroutineScope {
                            merged.filter { !it.isSelf }.map { h ->
                                async { gate.withPermit { Fingerprint.probe(h.ip, h.ports.toSet(), local, { java.net.Socket() }, {}) } }
                            }.awaitAll().filter { it.texts.isNotEmpty() }.associate { it.ip to it.texts }
                        }
                    }
                    Quad(found, merged, devices, prints)
                } finally {
                    lock.release()
                }
            }
        }
        // vendors of the MACs without one (outside the Wi-Fi binding: the registry is on the server)
        val missing = merged.filter { it.vendor == null && it.mac != null }.mapNotNull { it.mac }.distinct()
        val vendors = if (missing.isEmpty()) emptyMap() else {
            progress("Produttori dai MAC (${missing.size})…")
            runCatching { vendorOf(missing) }.getOrDefault(emptyMap())
        }
        val enriched = merged.map { h -> h.mac?.let { vendors[it] }?.let { v -> if (h.vendor == null) h.copy(vendor = v) else h } ?: h }
        progress("Costruzione del grafo…")
        return TopologyRun(Topology.build(enriched, devices, gatewayIp, found, prints), found, enriched, devices)
    }

    private data class Quad(val found: List<Found>, val merged: List<ScanHost>, val devices: List<SnmpDevice>, val prints: Map<String, List<String>>)
}
