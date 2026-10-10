package it.cdanet.cpeconfigurator.tools.pro

import it.cdanet.cpeconfigurator.tools.topology.DeviceType

/** Best guess of what a host is, from vendor, open ports and name (shown as a hint, never trusted). */
object DeviceGuess {
    private fun v(vendor: String?, vararg names: String) = vendor != null && names.any { vendor.contains(it, ignoreCase = true) }

    fun guess(vendor: String?, ports: Set<Int>, hostname: String? = null, isGateway: Boolean = false, ubntModel: String? = null): String {
        val name = hostname.orEmpty()
        // factory hostnames and models name the product (E410-…, BRN…, ShellyPlus…, cnPilot…)
        val hint = it.cdanet.cpeconfigurator.tools.topology.ProductHints.of(hostname, ubntModel)
        if (ubntModel == null && hint?.type != null) {
            return if (hint.vendor in it.cdanet.cpeconfigurator.tools.topology.ProductHints.GENERIC) hint.type.label else "${hint.type.label} ${hint.vendor}"
        }
        return when {
            ubntModel != null -> "Ubiquiti $ubntModel"
            v(vendor, "Ubiquiti") -> if (20443 in ports || 20080 in ports) "Ubiquiti (CPE CDA Net)" else "Ubiquiti"
            v(vendor, "MikroTik", "Routerboard") || 8291 in ports || 8728 in ports -> "MikroTik"
            v(vendor, "Hikvision", "Dahua", "Uniview", "Hangzhou", "Zhejiang", "Axis", "Hanwha", "Vivotek", "Reolink", "Xiongmai") ||
                37777 in ports || 34567 in ports || (554 in ports && 8000 in ports) -> "Telecamera / NVR"
            554 in ports -> "Dispositivo RTSP (telecamera?)"
            v(vendor, "Hewlett", "HP Inc", "Brother", "Epson", "Canon", "Kyocera", "Ricoh", "Xerox", "Lexmark", "Konica", "Sharp") ||
                9100 in ports || 515 in ports -> "Stampante"
            v(vendor, "Cambium", "Mimosa", "Siklu", "Radwin", "Intracom", "SIAE") -> "Radio / access point"
            v(vendor, "Ruckus", "Aruba", "Meraki", "Extreme Networks", "Engenius", "Edimax", "Grandstream Networks") && 5060 !in ports -> "Access point"
            v(vendor, "Yealink", "Fanvil", "Snom", "Gigaset", "Polycom", "Avaya", "Alcatel-Lucent Enterprise") || 5060 in ports -> "Telefono VoIP"
            v(vendor, "Teltonika", "DrayTek", "Zyxel", "Sagemcom", "Technicolor", "FiberHome", "Sercomm", "Askey", "Arcadyan") -> "Router / gateway"
            v(vendor, "Apple") || 62078 in ports || 548 in ports -> "Apple (iPhone/iPad/Mac)"
            8008 in ports || 8009 in ports || v(vendor, "Google") -> "Chromecast / Google"
            v(vendor, "Espressif", "Tuya", "Shelly", "Sonoff", "Itead", "Xiaomi", "Broadlink") -> "IoT / domotica"
            v(vendor, "Synology", "QNAP") || 5000 in ports && 5001 in ports -> "NAS"
            445 in ports || 3389 in ports || 135 in ports -> "PC / server Windows"
            isGateway || v(vendor, "TP-Link", "AVM", "Technicolor", "Sagemcom", "Huawei", "ZTE", "Netgear", "ASUSTek", "D-Link", "Tenda", "Zyxel", "Cisco", "Fortinet", "Draytek") ||
                (53 in ports && 80 in ports) -> if (isGateway) "Router / gateway" else "Router / access point"
            v(vendor, "Samsung", "LG Electronics", "Sony", "Hisense", "TCL", "Philips") -> "TV / elettronica"
            22 in ports && ports.size <= 2 -> "Linux / dispositivo SSH"
            name.contains("android", true) -> "Android"
            else -> ""
        }
    }

    /** Device type of a guess label ("Telecamera / NVR", "Access point Cambium", "Router MikroTik"…), for icons and colors. */
    fun type(kind: String, isGateway: Boolean = false): DeviceType {
        if (isGateway) return DeviceType.Router
        val k = kind.lowercase()
        DeviceType.entries.firstOrNull { it != DeviceType.Unknown && it != DeviceType.Internet && k.startsWith(it.label.lowercase()) }?.let { return it }
        return when {
            k.isBlank() -> DeviceType.Unknown
            "nvr" in k && "telecamera" !in k -> DeviceType.Nvr
            "telecamera" in k || "rtsp" in k -> DeviceType.Camera
            "radio" in k || "antenna" in k || "cpe" in k -> DeviceType.Cpe
            "access point" in k -> DeviceType.AccessPoint
            "firewall" in k -> DeviceType.Firewall
            "router" in k || "gateway" in k || "routerboard" in k -> DeviceType.Router
            "switch" in k -> DeviceType.Switch
            "ont" in k || "modem" in k -> DeviceType.Ont
            "stampante" in k -> DeviceType.Printer
            "nas" in k -> DeviceType.Nas
            "voip" in k -> DeviceType.VoipPhone
            "pc" in k || "windows" in k || "computer" in k || "mac" in k -> DeviceType.Computer
            "server" in k || "linux" in k || "ssh" in k -> DeviceType.Server
            "iphone" in k || "android" in k || "smartphone" in k -> DeviceType.Phone
            "tv" in k || "chromecast" in k || "multimedia" in k -> DeviceType.Tv
            "iot" in k || "domotica" in k -> DeviceType.Iot
            else -> DeviceType.Unknown
        }
    }
}
