package it.cdanet.cpeconfigurator.tools.pro

/** Best guess of what a host is, from vendor, open ports and name (shown as a hint, never trusted). */
object DeviceGuess {
    private fun v(vendor: String?, vararg names: String) = vendor != null && names.any { vendor.contains(it, ignoreCase = true) }

    fun guess(vendor: String?, ports: Set<Int>, hostname: String? = null, isGateway: Boolean = false, ubntModel: String? = null): String {
        val name = hostname.orEmpty()
        return when {
            ubntModel != null -> "Ubiquiti $ubntModel"
            v(vendor, "Ubiquiti") -> if (20443 in ports || 20080 in ports) "Ubiquiti (CPE CDA Net)" else "Ubiquiti"
            v(vendor, "MikroTik", "Routerboard") || 8291 in ports || 8728 in ports -> "MikroTik"
            v(vendor, "Hikvision", "Dahua", "Uniview", "Hangzhou", "Zhejiang", "Axis", "Hanwha", "Vivotek", "Reolink", "Xiongmai") ||
                37777 in ports || 34567 in ports || (554 in ports && 8000 in ports) -> "Telecamera / NVR"
            554 in ports -> "Dispositivo RTSP (telecamera?)"
            v(vendor, "Hewlett", "HP Inc", "Brother", "Epson", "Canon", "Kyocera", "Ricoh", "Xerox", "Lexmark", "Konica", "Sharp") ||
                9100 in ports || 515 in ports -> "Stampante"
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
}
