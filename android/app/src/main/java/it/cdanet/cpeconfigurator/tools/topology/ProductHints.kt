package it.cdanet.cpeconfigurator.tools.topology

/**
 * Vendor and device type from product names: hostnames that devices keep from the factory
 * ("E410-1A2B3C", "BRN3C2AF4…", "ShellyPlus1PM-…") and model strings of discovery, SNMP or web
 * pages. Used when the MAC vendor is unknown or generic, and to tell an AP from a radio or a switch.
 */
object ProductHints {
    data class Hint(val vendor: String, val type: DeviceType?)

    private fun r(p: String) = Regex(p, RegexOption.IGNORE_CASE)
    private val A = DeviceType.AccessPoint
    private val C = DeviceType.Cpe
    private val S = DeviceType.Switch
    private val R = DeviceType.Router

    /** Checked in order: the first match wins. Patterns on word starts to avoid accidental hits. */
    private val RULES: List<Triple<Regex, String, DeviceType?>> = listOf(
        // Cambium: cnPilot indoor/outdoor APs (e400…e700, r-series), ePMP/Force/PMP radios, cnMatrix switches, cnWave
        Triple(r("""\b(cnpilot|e4[0-9]0|e5[0-9]{2}|e6[0-9]0|e7[0-9]0|xv[0-9]-|xe[0-9]-)"""), "Cambium", A),
        Triple(r("""\b(epmp|force[ _-]?(1[0-9]{2}|2[0-9]{2}|3[0-9]{2}|4[0-9]{2})|f300|pmp[ _-]?4[0-9]{2}|cnwave|cnreach|ptp[ _-]?[0-9]{3})"""), "Cambium", C),
        Triple(r("""\bcnmatrix"""), "Cambium", S),
        Triple(r("""\bcambium"""), "Cambium", null),
        // Mimosa
        Triple(r("""\bmimosa|\b(a5c|a5x|c5c|c5x|b5c|b5-|b11|b24)\b"""), "Mimosa", C),
        // Ubiquiti
        Triple(r("""\b(uap|u6-|u7-|unifi[ -]?ap|uap-|nanohd|flexhd|beaconhd|liteap|rocket|prism)"""), "Ubiquiti", A),
        Triple(r("""\b(lbe-|nbe-|pbe-|litebeam|nanobeam|powerbeam|nanostation|loco|airgrid|isostation|airfiber|af-?[0-9]|ltu|gigabeam|wave-|airmax)"""), "Ubiquiti", C),
        Triple(r("""\b(usw-|us-[0-9]|edgeswitch|es-[0-9]{2}|unifi[ -]?switch|usw)"""), "Ubiquiti", S),
        Triple(r("""\b(udm|uxg|usg|ucg|udr|edgerouter|er-[0-9x]|unifi[ -]?(gateway|dream))"""), "Ubiquiti", R),
        Triple(r("""\b(ubnt|ubiquiti|unifi)\b"""), "Ubiquiti", null),
        // MikroTik
        Triple(r("""\b(cap[ -]?(ac|ax|xl|lite)|wap[ -]?(ac|ax|lte|r)|hap[ -]?(ac|ax|lite|mini|lite)|audience)"""), "MikroTik", A),
        Triple(r("""\b(sxt|lhg|ldf|disc[ -]?(lite|pro)|wireless wire|cube[ -]?60|netmetal|groove|metal[ -]?5)"""), "MikroTik", C),
        Triple(r("""\b(crs[0-9]|css[0-9]|netpower)"""), "MikroTik", S),
        Triple(r("""\b(ccr[0-9]|chr\b|hex\b|rb[0-9]|routerboard|routeros|rb-|l009|l00[0-9])"""), "MikroTik", R),
        Triple(r("""\bmikrotik"""), "MikroTik", null),
        // TP-Link
        Triple(r("""\b(eap[0-9]{3}|omada[ -]?ap)"""), "TP-Link", A),
        Triple(r("""\b(cpe[0-9]{3}|wbs[0-9]{3}|pharos)"""), "TP-Link", C),
        Triple(r("""\b(tl-sg|sg[0-9]{4}|jetstream|t[0-9]{4}g)"""), "TP-Link", S),
        Triple(r("""\b(archer|deco|tl-wr|tl-mr|er[0-9]{3,4}|omada)"""), "TP-Link", R),
        // other network vendors
        Triple(r("""\b(ruckus|zonedirector|unleashed)"""), "Ruckus", A),
        Triple(r("""\b(aruba|instant[ -]?on|iap-|ap-[0-9]{3})"""), "Aruba", A),
        Triple(r("""\bmr[0-9]{2}\b|\bmeraki"""), "Cisco Meraki", A),
        Triple(r("""\bms[0-9]{3}\b"""), "Cisco Meraki", S),
        Triple(r("""\bmx[0-9]{2,3}\b"""), "Cisco Meraki", DeviceType.Firewall),
        Triple(r("""\b(fortigate|fgt|fwf)"""), "Fortinet", DeviceType.Firewall),
        Triple(r("""\b(fortiap|fap-)"""), "Fortinet", A),
        Triple(r("""\b(fortiswitch|fsw-)"""), "Fortinet", S),
        Triple(r("""\b(gwn[0-9]{4})"""), "Grandstream", A),
        Triple(r("""\b(rut[0-9]{3}|rutx|teltonika|tcr1|trb[0-9])"""), "Teltonika", R),
        Triple(r("""\bvigor"""), "DrayTek", R),
        Triple(r("""\b(zyxel|nbg[0-9]|vmg[0-9]|usg[ -]?flex|nwa[0-9]|gs[0-9]{4})"""), "Zyxel", null),
        Triple(r("""\b(fritz|fritzbox)"""), "AVM", R),
        Triple(r("""\b(hg8[0-9]{3}|echolife|optixstar)"""), "Huawei", DeviceType.Ont),
        Triple(r("""\b(zxhn|f6[0-9]{2}|f6[0-9]{2}v)"""), "ZTE", DeviceType.Ont),
        Triple(r("""\b(catalyst|c9[0-9]{3}|ws-c|sg[0-9]{3}-)"""), "Cisco", S),
        Triple(r("""\b(netgear|gs[0-9]{3}|rbr[0-9]|orbi|nighthawk)"""), "Netgear", null),
        Triple(r("""\b(dgs-|des-|dir-[0-9]|dap-)"""), "D-Link", null),
        Triple(r("""\b(linksys|velop)"""), "Linksys", R),
        Triple(r("""\b(starlink)"""), "SpaceX Starlink", R),
        // phones, cameras, printers
        Triple(r("""\b(gxp[0-9]|grp[0-9]|gxv[0-9]|ht8[0-9]{2}|dp7[0-9]{2}|wp8[0-9]{2})"""), "Grandstream", DeviceType.VoipPhone),
        Triple(r("""\b(sip-t[0-9]|yealink|t[0-9]{2}[gpwu]\b|w[0-9]{2}p)"""), "Yealink", DeviceType.VoipPhone),
        Triple(r("""\b(fanvil|x[0-9]u\b)"""), "Fanvil", DeviceType.VoipPhone),
        Triple(r("""\b(snom|gigaset|polycom|vvx)"""), "VoIP", DeviceType.VoipPhone),
        Triple(r("""\b(ds-[0-9]{1,2}[a-z]{2}[0-9]|hikvision|ezviz)"""), "Hikvision", DeviceType.Camera),
        Triple(r("""\b(ds-7[0-9]{3}|ds-9[0-9]{3}|ivms|hiknvr)"""), "Hikvision", DeviceType.Nvr),
        Triple(r("""\b(ipc-h[a-z]{2}[0-9]|dh-ipc|imou|dahua)"""), "Dahua", DeviceType.Camera),
        Triple(r("""\b(nvr[0-9]{2,4}|xvr[0-9]|dhi-nvr)"""), "Dahua", DeviceType.Nvr),
        Triple(r("""\b(reolink|rlc-[0-9])"""), "Reolink", DeviceType.Camera),
        Triple(r("""\b(axis-[0-9a-f]{12}|axis\b)"""), "Axis", DeviceType.Camera),
        Triple(r("""\b(xnv|qnv|pnv|xno|qno|hanwha|wisenet)"""), "Hanwha", DeviceType.Camera),
        Triple(r("""\b(ipc[0-9]{4}|uniview|unv)"""), "Uniview", DeviceType.Camera),
        Triple(r("""\b(brn|brw)[0-9a-f]{12}"""), "Brother", DeviceType.Printer),
        Triple(r("""\b(npi[0-9a-f]{6}|hp[0-9a-f]{6}|laserjet|officejet|deskjet)"""), "HP", DeviceType.Printer),
        Triple(r("""\b(epson|et-[0-9]{4}|wf-[0-9]{4})"""), "Epson", DeviceType.Printer),
        Triple(r("""\b(canon|mf[0-9]{3}|ir-adv)"""), "Canon", DeviceType.Printer),
        Triple(r("""\b(kyocera|ecosys|taskalfa|ricoh|aficio|xerox|lexmark|konica|bizhub)"""), "Stampante", DeviceType.Printer),
        // NAS, servers, IoT, media
        Triple(r("""\b(synology|diskstation|ds[0-9]{3,4}\+?|rs[0-9]{3,4})"""), "Synology", DeviceType.Nas),
        Triple(r("""\b(qnap|ts-[0-9]{3})"""), "QNAP", DeviceType.Nas),
        Triple(r("""\b(truenas|freenas|unraid|mycloud|wdmycloud|readynas)"""), "NAS", DeviceType.Nas),
        Triple(r("""\b(proxmox|pve[0-9-]*\b|esxi|vcenter|idrac|ilo[0-9]?\b|ipmi|supermicro|xcp-ng|truenas-scale)"""), "Server", DeviceType.Server),
        Triple(r("""\b(raspberrypi|rpi[0-9]?\b|raspberry)"""), "Raspberry Pi", DeviceType.Server),
        Triple(r("""\b(shelly|shellyplus|shellypro)"""), "Shelly", DeviceType.Iot),
        Triple(r("""\b(sonoff|tasmota|esphome|esp32|esp8266|esp-|wled|tuya|smartlife|tradfri|dirigera|philips-hue|hue-bridge|yeelight|zigbee|homey|home-assistant|homeassistant)"""), "IoT", DeviceType.Iot),
        Triple(r("""\b(chromecast|google-?home|nest-|androidtv|bravia|webos|lgwebos|samsung-?tv|tizen|roku|firetv|fire-tv|apple-?tv|sonos|denon|yamaha|heos)"""), "Media", DeviceType.Tv),
        Triple(r("""\b(iphone|ipad|galaxy-|sm-[a-z][0-9]{3}|pixel-?[0-9]|android-[0-9a-f]{8,}|redmi|oneplus|huawei-p)"""), "Smartphone", DeviceType.Phone),
        Triple(r("""\b(macbook|imac|mac-?mini|desktop-[0-9a-z]{7}|laptop-[0-9a-z]{7}|pc-[a-z0-9]+)"""), "Computer", DeviceType.Computer),
        Triple(r("""\b(apc|smart-?ups|ups[0-9]?\b|eaton|riello)"""), "UPS", DeviceType.Server),
    )

    /** The first hint for any of the names, or null. Generic labels ("IoT", "Server"…) carry only a type. */
    fun of(vararg names: String?): Hint? {
        for (n in names) {
            val text = n?.takeIf { it.isNotBlank() } ?: continue
            for ((re, vendor, type) in RULES) if (re.containsMatchIn(text)) return Hint(vendor, type)
        }
        return null
    }

    /** Hint vendors that are a category, not a company: never shown as the vendor. */
    val GENERIC = setOf("IoT", "Media", "Smartphone", "Computer", "Server", "UPS", "NAS", "VoIP", "Stampante")
}
