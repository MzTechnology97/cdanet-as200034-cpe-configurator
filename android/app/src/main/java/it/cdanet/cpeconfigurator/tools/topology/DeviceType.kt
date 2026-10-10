package it.cdanet.cpeconfigurator.tools.topology

/** What a device of the graph is, for its icon (UniFi-like topology). */
enum class DeviceType(val label: String) {
    Internet("Internet"),
    Router("Router"),
    Firewall("Firewall"),
    Ont("Modem / ONT"),
    Switch("Switch"),
    AccessPoint("Access point"),
    Cpe("Antenna / ponte radio"),
    Camera("Telecamera"),
    Nvr("NVR / DVR"),
    Computer("Computer"),
    Server("Server"),
    Nas("NAS"),
    Printer("Stampante"),
    Phone("Smartphone / tablet"),
    VoipPhone("Telefono VoIP"),
    Tv("TV / multimedia"),
    Iot("IoT / domotica"),
    Unknown("Dispositivo"),
    ;

    /** Network devices: drawn as tiles in the tree, the rest as small client circles. */
    val infra: Boolean get() = this in setOf(Internet, Router, Firewall, Ont, Switch, AccessPoint, Cpe)
}

/** Everything known about a device, for [DeviceClassifier]. */
data class DeviceEvidence(
    val vendor: String? = null,
    val kind: String = "",
    val model: String? = null,
    val sysDescr: String? = null,
    val sysObjectId: String? = null,
    /** LLDP capabilities announced by the device or seen by its neighbors. */
    val capabilities: Set<String> = emptySet(),
    val ports: Set<Int> = emptySet(),
    /** Fingerprints: HTTP server/title, SSH banner, RTSP/SIP user agent, WS-Discovery types, mDNS services. */
    val fingerprints: List<String> = emptyList(),
    val protocols: Set<String> = emptySet(),
    val isGateway: Boolean = false,
    val hostname: String? = null,
)

/** Device type and vendor from everything the scan, discovery, SNMP and fingerprints said. Pure, unit-tested. */
object DeviceClassifier {
    /** SNMP enterprise numbers (sysObjectID 1.3.6.1.4.1.N…) of common network vendors. */
    val ENTERPRISES = mapOf(
        9 to "Cisco", 11 to "HP", 171 to "D-Link", 311 to "Microsoft", 367 to "Ricoh", 368 to "Axis", 674 to "Dell",
        1248 to "Epson", 1347 to "Kyocera", 1602 to "Canon", 1916 to "Extreme Networks", 1991 to "Brocade", 2011 to "Huawei",
        2021 to "Linux (net-snmp)", 2435 to "Brother", 2620 to "Check Point", 2636 to "Juniper", 3375 to "F5", 3902 to "ZTE",
        4413 to "Broadcom (EdgeSwitch)", 4526 to "Netgear", 4881 to "Ruijie", 6486 to "Alcatel-Lucent", 6527 to "Nokia",
        6574 to "Synology", 6876 to "VMware", 8072 to "Linux (net-snmp)", 8741 to "SonicWall", 11863 to "TP-Link",
        12356 to "Fortinet", 14988 to "MikroTik", 17713 to "Cambium", 24681 to "QNAP", 25461 to "Palo Alto", 25506 to "H3C",
        30065 to "Arista", 39165 to "Hikvision", 41112 to "Ubiquiti",
    )

    fun vendorOfObjectId(oid: String?): String? =
        oid?.removePrefix(".")?.removePrefix("1.3.6.1.4.1.")?.takeIf { it != oid }?.substringBefore('.')?.toIntOrNull()?.let { ENTERPRISES[it] }

    private fun has(text: String, vararg words: String) = words.any { it in text }

    /** Product name hint from hostname, model and fingerprints. */
    fun hint(e: DeviceEvidence) = ProductHints.of(e.hostname, e.model, *e.fingerprints.toTypedArray())

    /** Only the device's own name and model: strong enough to decide the type before the generic rules. */
    private fun nameHint(e: DeviceEvidence) = ProductHints.of(e.hostname, e.model)

    fun vendor(e: DeviceEvidence): String? =
        e.vendor?.takeIf { it.isNotBlank() } ?: vendorOfObjectId(e.sysObjectId) ?: hint(e)?.vendor?.takeIf { it !in ProductHints.GENERIC } ?: run {
            val t = (e.sysDescr.orEmpty() + " " + e.fingerprints.joinToString(" ") + " " + e.model.orEmpty()).lowercase()
            when {
                has(t, "routeros", "mikrotik", "rosssh") -> "MikroTik"
                has(t, "airos", "ubiquiti", "unifi", "edgeos", "edgeswitch") -> "Ubiquiti"
                has(t, "hikvision", "dnvrs-webs", "app-webs") -> "Hikvision"
                has(t, "dahua") -> "Dahua"
                has(t, "fritz!box", "fritz!") -> "AVM"
                has(t, "synology", "diskstation") -> "Synology"
                has(t, "qnap") -> "QNAP"
                has(t, "yealink") -> "Yealink"
                has(t, "grandstream") -> "Grandstream"
                has(t, "fortigate", "fortinet") -> "Fortinet"
                has(t, "huawei", "echolife") -> "Huawei"
                has(t, "tp-link", "tplink", "omada") -> "TP-Link"
                has(t, "cisco") -> "Cisco"
                else -> null
            }
        }

    fun classify(e: DeviceEvidence): DeviceType {
        val model = e.model.orEmpty().lowercase()
        val t = listOf(e.kind, e.vendor.orEmpty(), e.model.orEmpty(), e.sysDescr.orEmpty(), e.hostname.orEmpty(), e.fingerprints.joinToString(" "), vendorOfObjectId(e.sysObjectId).orEmpty())
            .joinToString(" ").lowercase()
            // the scanner's generic "Telecamera / NVR" must not make every camera a recorder
            .replace("telecamera / nvr", "telecamera")
            .replace("pc / server windows", "pc windows")
        val caps = e.capabilities.map { it.lowercase() }.toSet()
        // a product name (hostname, model) says what the device is, before generic words
        nameHint(e)?.type?.let { t -> return if (e.isGateway && t in setOf(DeviceType.AccessPoint, DeviceType.Switch)) DeviceType.Router else t }
        return when {
            // explicit fingerprints first: they name the product
            has(t, "fortigate", "pfsense", "opnsense", "sophos", "sonicwall", "watchguard", "palo alto", "check point") -> DeviceType.Firewall
            has(t, "echolife", "hg8245", "zxhn", "ont ", "gpon", "fibra", "dsl", "fritz!box", "vodafone station", "technicolor", "sagemcom") && !has(t, "switch") -> if (e.isGateway || has(t, "fritz!box")) DeviceType.Router else DeviceType.Ont
            has(t, "nvr", "dvr", "dnvrs") -> DeviceType.Nvr
            has(t, "telecamera", "camera", "ipc-", "network video", "networkvideotransmitter", "axis", "app-webs", "rtsp server", "hikvision", "dahua", "reolink", "uniview", "vivotek", "hanwha") -> DeviceType.Camera
            has(t, "yealink", "grandstream", "snom", "fanvil", "gigaset", "polycom", "voip", "sip-t", "deskphone") || "telephone" in caps -> DeviceType.VoipPhone
            has(t, "stampante", "printer", "laserjet", "officejet", "brother", "epson", "kyocera", "ricoh", "xerox", "lexmark", "_ipp", "print device") -> DeviceType.Printer
            has(t, "synology", "diskstation", "qnap", "truenas", "freenas", "nas") -> DeviceType.Nas
            // network devices by model family
            has(model, "uap", "u6-", "u7-", "liteap", "rocket", "prism", "airmax ac ap", "cap ", "wap ", "eap", "access point") -> DeviceType.AccessPoint
            has(model, "litebeam", "nanobeam", "powerbeam", "nanostation", "loco", "airgrid", "isostation", "lbe-", "nbe-", "pbe-", "sxt", "lhg", "ldf", "disc", "wireless wire", "60g", "airfiber", "gigabeam") -> DeviceType.Cpe
            has(t, "edgeswitch", "usw-", "crs", "css", "switch", "jetstream", "procurve", "catalyst", "aruba") || ("bridge" in caps && "router" !in caps && "wlan access point" !in caps) -> DeviceType.Switch
            has(t, "access point", "unifi ap") || "wlan access point" in caps -> DeviceType.AccessPoint
            has(t, "ubiquiti", "airos") && !e.isGateway -> DeviceType.Cpe
            e.isGateway || has(t, "router", "routeros", "mikrotik", "edgerouter", "gateway", "udm", "usg") || "router" in caps -> DeviceType.Router
            // end devices
            has(t, "tv", "multimedia", "chromecast", "googlecast", "airplay", "sonos", "roku", "fire tv", "webos", "tizen", "mediarenderer") -> DeviceType.Tv
            has(t, "iot", "domotica", "shelly", "tasmota", "esphome", "espressif", "tuya", "sonoff", "hue", "homekit", "_hap", "matter", "xiaomi") -> DeviceType.Iot
            has(t, "iphone", "ipad", "android", "smartphone", "tablet", "companion-link") -> DeviceType.Phone
            has(t, "server", "proxmox", "esxi", "vmware", "ubuntu", "debian", "centos", "openssh", "linux / dispositivo ssh", "iis") -> DeviceType.Server
            has(t, "pc ", "windows", "workstation", "computer", "_smb", "netbios", "macbook", "imac", "apple (iphone/ipad/mac)") -> DeviceType.Computer
            // last: what a fingerprint names (web title, SIP agent…)
            else -> hint(e)?.type ?: DeviceType.Unknown
        }
    }
}

/** A vendor badge: short text and a color of our own (no trademark logo is copied). */
data class VendorBadge(val short: String, val color: Long)

object VendorBadges {
    private val BADGES = listOf(
        "ubiquiti" to VendorBadge("UBNT", 0xFF0559C9), "mikrotik" to VendorBadge("MT", 0xFF293239), "routerboard" to VendorBadge("MT", 0xFF293239),
        "cisco" to VendorBadge("CSCO", 0xFF049FD9), "tp-link" to VendorBadge("TPL", 0xFF4ACBD6), "huawei" to VendorBadge("HW", 0xFFC7000B),
        "zte" to VendorBadge("ZTE", 0xFF0060A9), "netgear" to VendorBadge("NG", 0xFF6A1B9A), "d-link" to VendorBadge("DL", 0xFF0B7FAB),
        "avm" to VendorBadge("AVM", 0xFFE2001A), "hikvision" to VendorBadge("HIK", 0xFFD7000F), "hangzhou" to VendorBadge("HIK", 0xFFD7000F),
        "dahua" to VendorBadge("DH", 0xFFE60012), "zhejiang dahua" to VendorBadge("DH", 0xFFE60012), "axis" to VendorBadge("AXIS", 0xFFFFC600),
        "synology" to VendorBadge("SYN", 0xFF2B2B2B), "qnap" to VendorBadge("QNAP", 0xFF1E6FD9), "hewlett" to VendorBadge("HP", 0xFF0096D6),
        "hp " to VendorBadge("HP", 0xFF0096D6), "dell" to VendorBadge("DELL", 0xFF007DB8), "lenovo" to VendorBadge("LNV", 0xFFE2231A),
        "apple" to VendorBadge("APL", 0xFF555555), "samsung" to VendorBadge("SAM", 0xFF1428A0), "lg electronics" to VendorBadge("LG", 0xFFA50034),
        "sony" to VendorBadge("SONY", 0xFF111111), "xiaomi" to VendorBadge("MI", 0xFFFF6900), "google" to VendorBadge("GGL", 0xFF4285F4),
        "amazon" to VendorBadge("AMZ", 0xFFFF9900), "intel" to VendorBadge("INTL", 0xFF0071C5), "raspberry" to VendorBadge("RPI", 0xFFC51A4A),
        "espressif" to VendorBadge("ESP", 0xFFE7352C), "shelly" to VendorBadge("SHLY", 0xFF4A90E2), "sonos" to VendorBadge("SNS", 0xFF000000),
        "brother" to VendorBadge("BRO", 0xFF0D2481), "canon" to VendorBadge("CAN", 0xFFCC0000), "epson" to VendorBadge("EPS", 0xFF003399),
        "ricoh" to VendorBadge("RIC", 0xFFCF142B), "kyocera" to VendorBadge("KYO", 0xFFE60012), "yealink" to VendorBadge("YEA", 0xFF00A0E9),
        "grandstream" to VendorBadge("GS", 0xFF1F5FAA), "fortinet" to VendorBadge("FTNT", 0xFFEE3124), "cambium" to VendorBadge("CMB", 0xFF6CB33F),
        "mimosa" to VendorBadge("MIM", 0xFF00AEEF), "tenda" to VendorBadge("TND", 0xFFF39800), "asustek" to VendorBadge("ASUS", 0xFF00539B),
        "asus" to VendorBadge("ASUS", 0xFF00539B), "microsoft" to VendorBadge("MS", 0xFF737373), "vmware" to VendorBadge("VMW", 0xFF607078),
        "juniper" to VendorBadge("JNPR", 0xFF84B135), "aruba" to VendorBadge("ARB", 0xFFFF8300), "zyxel" to VendorBadge("ZYX", 0xFF0067B1),
        "draytek" to VendorBadge("DRT", 0xFF005BAC), "teltonika" to VendorBadge("TLT", 0xFF0054A6), "reolink" to VendorBadge("REO", 0xFF0072CE),
        "uniview" to VendorBadge("UNV", 0xFF0055A4), "broadcom" to VendorBadge("UBNT", 0xFF0559C9), "realtek" to VendorBadge("RTK", 0xFF2F5597),
        "ruckus" to VendorBadge("RKS", 0xFFF57E20), "meraki" to VendorBadge("MRK", 0xFF67B346), "extreme" to VendorBadge("EXTR", 0xFF7A2C8E),
        "fanvil" to VendorBadge("FNV", 0xFF00A0DC), "snom" to VendorBadge("SNOM", 0xFF5C5C5C), "gigaset" to VendorBadge("GIG", 0xFF0098D8),
        "polycom" to VendorBadge("POLY", 0xFFE3003A), "western digital" to VendorBadge("WD", 0xFF0067B4), "american power" to VendorBadge("APC", 0xFF00A651),
        "apc" to VendorBadge("APC", 0xFF00A651), "eaton" to VendorBadge("EAT", 0xFF005EB8), "supermicro" to VendorBadge("SMC", 0xFF00539F),
        "hewlett packard enterprise" to VendorBadge("HPE", 0xFF01A982), "ezviz" to VendorBadge("EZV", 0xFFE8382D), "imou" to VendorBadge("IMOU", 0xFFFF6A00),
        "linksys" to VendorBadge("LNK", 0xFF1A1A1A), "starlink" to VendorBadge("SL", 0xFF000000), "sagemcom" to VendorBadge("SGM", 0xFF00A6D6),
        "technicolor" to VendorBadge("TCH", 0xFF5B2C83), "fiberhome" to VendorBadge("FH", 0xFF0072BC), "sercomm" to VendorBadge("SRC", 0xFF00539B),
        "ikea" to VendorBadge("IKEA", 0xFF0058A3), "philips" to VendorBadge("PHL", 0xFF0B5ED7), "signify" to VendorBadge("HUE", 0xFF0B5ED7),
        "tuya" to VendorBadge("TUYA", 0xFFFF4800), "sonoff" to VendorBadge("SNF", 0xFF1DA1F2), "itead" to VendorBadge("SNF", 0xFF1DA1F2),
        "proxmox" to VendorBadge("PVE", 0xFFE57000), "nvidia" to VendorBadge("NV", 0xFF76B900), "huawei device" to VendorBadge("HW", 0xFFC7000B),
        "oneplus" to VendorBadge("1+", 0xFFEB0028), "oppo" to VendorBadge("OPPO", 0xFF046A38), "motorola" to VendorBadge("MOT", 0xFF001428),
        "nokia" to VendorBadge("NOK", 0xFF124191), "ericsson" to VendorBadge("ERI", 0xFF0082F0), "siklu" to VendorBadge("SKL", 0xFF00AEEF),
        "radwin" to VendorBadge("RDW", 0xFF0072CE), "siae" to VendorBadge("SIAE", 0xFF003B71), "engenius" to VendorBadge("ENG", 0xFF0072BC),
        "edimax" to VendorBadge("EDX", 0xFF003C71), "avm" to VendorBadge("AVM", 0xFFE2001A), "vodafone" to VendorBadge("VF", 0xFFE60000),
        "spacex" to VendorBadge("SL", 0xFF000000), "texas instruments" to VendorBadge("TI", 0xFFCC0000), "murata" to VendorBadge("MUR", 0xFF0067B1),
        "azurewave" to VendorBadge("AZW", 0xFF1E3A8A), "liteon" to VendorBadge("LITE", 0xFF00539B), "hon hai" to VendorBadge("FXN", 0xFF0055A5),
    )

    fun of(vendor: String?): VendorBadge? {
        val v = vendor?.lowercase()?.takeIf { it.isNotBlank() } ?: return null
        return BADGES.firstOrNull { (k, _) -> k in "$v " }?.second
    }
}
